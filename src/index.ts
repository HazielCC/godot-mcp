#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize, resolve as resolvePath, relative, isAbsolute } from 'path';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, cpSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
/** Commands the editor bridge accepts (see src/addons/godot_mcp_bridge/plugin.gd). */
const EDITOR_BRIDGE_COMMANDS = [
  'status', 'scene_tree', 'open_scene', 'save_scene', 'get_property', 'set_property',
  'add_node', 'undo', 'redo', 'play', 'stop', 'refresh_filesystem', 'probe_status', 'probe_capture',
];

/** Codes for errors a caller can act on. Errors without a code report OPERATION_FAILED. */
type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_PATH'
  | 'PROJECT_NOT_FOUND'
  | 'GODOT_NOT_FOUND'
  | 'IMPORT_FAILED'
  | 'TEST_DIRECTORY_NOT_FOUND'
  | 'TESTS_NOT_RUN'
  | 'TIMEOUT'
  | 'EDITOR_NOT_CONNECTED'
  | 'EDITOR_TIMEOUT'
  | 'EDITOR_REFUSED'
  | 'PROBE_NOT_READY'
  | 'OPERATION_FAILED';

/** Codes where repeating the same call later may succeed without changing its arguments. */
const RETRYABLE_ERROR_CODES: ToolErrorCode[] =['TIMEOUT', 'EDITOR_TIMEOUT', 'PROBE_NOT_READY'];

/** One test result, as read from GUT's JUnit XML. */
type TestRecord = { suite: string; name: string; status: string; time: number; message?: string };

/** The last full run_tests result of a project, kept in .godot/mcp_tests_last.json for rerunFailed. */
type TestState = { directory: string; savedAt: string; tests: TestRecord[] };

/** Properties that are stored inside the node's transform (see setPropertyInInheritedScene). */
const TRANSFORM_PROPERTIES = ['position', 'rotation', 'rotation_degrees', 'scale', 'skew'];

/** Attributes of a .tscn section header, such as [node name="Player" parent="."]. */
function parseSceneAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g)) {
    attributes[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attributes;
}

/** Key of a node relative to the scene root: '' for the root, 'Walls/WallFar' for nested nodes. */
function sceneNodeKey(parent: string | undefined, name: string): string {
  if (parent === undefined) {
    return '';
  }
  const parentKey = parent === '.' ? '' : parent;
  return parentKey === '' ? name : `${parentKey}/${name}`;
}

/** Key of a node from a path that starts with the root name, or null when it does not. */
function nodeKeyFromPath(nodePath: string, rootName: string): string | null {
  if (nodePath === rootName) {
    return '';
  }
  return nodePath.startsWith(`${rootName}/`) ? nodePath.slice(rootName.length + 1) : null;
}

/** Name of the root node: the first [node] section, which has no parent. */
function sceneRootName(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[node\s(.*)\]$/.exec(line.trim());
    if (header) {
      return parseSceneAttributes(header[1]).name ?? '';
    }
  }
  return '';
}

/** Lines of the section of a node: its header line, up to the next section. */
function locateNodeSection(lines: string[], key: string): { headerIndex: number; end: number } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const header = /^\[node\s(.*)\]$/.exec(lines[i].trim());
    if (!header) {
      continue;
    }
    const attributes = parseSceneAttributes(header[1]);
    if (sceneNodeKey(attributes.parent, attributes.name ?? '') !== key) {
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].trim().startsWith('[')) {
      end++;
    }
    return { headerIndex: i, end };
  }
  return undefined;
}

/**
 * Set one property in the section of a node and change nothing else in the file.
 * A node that the scene inherits but does not override has no section, so one is added
 * at the end that carries only the override.
 */
function setSceneProperty(text: string, key: string, property: string, literal: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const assignment = `${property} = ${literal}`;
  const section = locateNodeSection(lines, key);
  if (!section) {
    const segments = key.split('/');
    const name = segments.pop() ?? '';
    const parent = segments.length > 0 ? segments.join('/') : '.';
    const trimmed = text.replace(/\s*$/, '');
    return `${trimmed}${eol}${eol}[node name="${name}" parent="${parent}"]${eol}${assignment}${eol}`;
  }
  const escaped = property.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*=`);
  for (let i = section.headerIndex + 1; i < section.end; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = assignment;
      return lines.join(eol);
    }
  }
  lines.splice(section.headerIndex + 1, 0, assignment);
  return lines.join(eol);
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** True when the section of a node has a line for the property. */
function sceneSectionHasProperty(text: string, key: string, property: string): boolean {
  const lines = text.split(/\r?\n/);
  const section = locateNodeSection(lines, key);
  if (!section) {
    return false;
  }
  const pattern = new RegExp(`^${escapeRegExp(property)}\\s*=`);
  for (let i = section.headerIndex + 1; i < section.end; i++) {
    if (pattern.test(lines[i])) {
      return true;
    }
  }
  return false;
}

/** Remove the lines of the given properties from the section of a node. */
function removeSceneProperties(text: string, key: string, properties: string[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const section = locateNodeSection(lines, key);
  if (!section) {
    return text;
  }
  const pattern = new RegExp(`^(${properties.map(escapeRegExp).join('|')})\\s*=`);
  const kept = lines.filter((line, index) => {
    const inSection = index > section.headerIndex && index < section.end;
    return !(inSection && pattern.test(line));
  });
  return kept.join(eol);
}

/** Append a node section that has a name, a type and a parent, and no properties. */
function appendNodeSection(text: string, name: string, type: string, parent: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}${eol}${eol}[node name="${name}" type="${type}" parent="${parent}"]${eol}`;
}

/** Add an external resource declaration and return its id. An existing declaration is reused. */
function addExternalResource(text: string, type: string, path: string): { text: string; id: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('[ext_resource')) {
      const attributes = parseSceneAttributes(line.slice('[ext_resource'.length, -1));
      if (attributes.type === type && attributes.path === path && attributes.id) {
        return { text, id: attributes.id };
      }
    }
  }
  const count = lines.filter((line) => line.startsWith('[ext_resource')).length;
  const id = `${count + 1}_${Math.random().toString(36).slice(2, 7)}`;
  const declaration = `[ext_resource type="${type}" path="${path}" id="${id}"]`;
  let last = -1;
  lines.forEach((line, i) => {
    if (line.startsWith('[ext_resource')) {
      last = i;
    }
  });
  if (last >= 0) {
    lines.splice(last + 1, 0, declaration);
  } else {
    const header = lines.findIndex((line) => line.startsWith('[gd_scene'));
    lines.splice(header + 1, 0, '', declaration);
  }
  return { text: lines.join(eol), id };
}

/** Godot literal for a plain JSON value, or null when the value needs a resource or an object. */
function toGodotLiteral(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string' && !value.startsWith('res://') && !/[\r\n]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return null;
}

/** A node read from a .tscn file (see read_scene). */
interface SceneNodeInfo {
  name: string;
  type: string | null;
  parent: string | null;
  instance: string | null;
  // Path such as "root/Player", starting with the root name.
  path: string;
  properties: Record<string, string>;
  children: SceneNodeInfo[];
  // "scene": defined in this file. "inherited": from the base scene. "overridden": from the
  // base scene, with properties changed in this file.
  origin: 'scene' | 'inherited' | 'overridden';
}

/** Maximum lines kept per output stream (stdout and stderr) of a running Godot process. */
const MAX_BUFFERED_LINES = 2000;

/** Maximum script errors archived from lines that were already dropped from the buffers. */
const MAX_ARCHIVED_SCRIPT_ERRORS = 500;

/**
 * Parameters of each tool that are file paths inside the project. Every one of them is
 * checked before the tool runs, so no tool can read or write outside the project folder.
 */
const PROJECT_PATH_PARAMS: Record<string, string[]> = {
  create_scene: ['scenePath'],
  add_node: ['scenePath'],
  load_sprite: ['scenePath', 'texturePath'],
  save_scene: ['scenePath', 'newPath'],
  export_mesh_library: ['scenePath', 'outputPath'],
  get_uid: ['filePath'],
  read_scene: ['scenePath'],
  set_node_property: ['scenePath'],
};


/** Extensions Godot imports into a .import file and a cached resource (see diagnose_project). */
const IMPORTABLE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'tga', 'exr', 'hdr', 'dds',
  'wav', 'ogg', 'mp3', 'glb', 'gltf', 'fbx', 'ttf', 'otf', 'obj',
];

interface GodotProcess {
  process: any;
  output: string[];
  errors: string[];
  // Lines removed from the buffers to keep memory and responses bounded.
  droppedOutputLines: number;
  droppedErrorLines: number;
  // Script errors found in dropped lines, so trimming does not lose them.
  archivedScriptErrors: { file: string; line: number; message: string }[];
  // Same for WARNING blocks (GDScript warnings such as shadowed variables).
  archivedScriptWarnings: { file: string; line: number; message: string }[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for operation parameters
 */
interface OperationParams {
  [key: string]: any;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private checkScriptsPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    'project_path': 'projectPath',
    'scene_path': 'scenePath',
    'root_node_type': 'rootNodeType',
    'parent_node_path': 'parentNodePath',
    'node_type': 'nodeType',
    'node_name': 'nodeName',
    'texture_path': 'texturePath',
    'node_path': 'nodePath',
    'output_path': 'outputPath',
    'mesh_item_names': 'meshItemNames',
    'new_path': 'newPath',
    'file_path': 'filePath',
    'directory': 'directory',
    'recursive': 'recursive',
    'scene': 'scene',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    this.checkScriptsPath = join(__dirname, 'scripts', 'check_scripts.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = [], options: { code?: ToolErrorCode } = {}): any {
    const code: ToolErrorCode = options.code ?? 'OPERATION_FAILED';
    const retryable = RETRYABLE_ERROR_CODES.includes(code);
    // Log the error
    console.error(`[SERVER] Error response (${code}): ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
        {
          type: 'text',
          text: `Error code: ${code} (retryable: ${retryable ? 'yes' : 'no'})`,
        },
      ],
      isError: true,
      structuredContent: { error: { code, message, retryable } },
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  private validateClassName(name: string): boolean {
    if (!name) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env.GODOT_PATH) {
      const normalizedPath = normalize(process.env.GODOT_PATH);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
      );
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
        `${process.env.USERPROFILE}\\Godot\\Godot.exe`
      );
    } else if (osPlatform === 'linux') {
      possiblePaths.push(
        '/usr/bin/godot',
        '/usr/local/bin/godot',
        '/snap/bin/godot',
        `${process.env.HOME}/.local/bin/godot`
      );
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    // An explicit GODOT_PATH that does not work must not be replaced by a guessed default,
    // because the guess hides the misconfiguration and fails later with an unclear error.
    if (process.env.GODOT_PATH) {
      throw new Error(
        `GODOT_PATH is set to "${process.env.GODOT_PATH}", but that is not a working Godot executable, ` +
        'and Godot was not found in the common locations. Fix GODOT_PATH or remove it.'
      );
    }

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      this.activeProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      return major > 4 || (major === 4 && minor >= 4);
    }
    return false;
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') {
      return params;
    }
    
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        let normalizedKey = key;
        
        // If the key is in snake_case, convert it to camelCase using our mapping
        if (key.includes('_') && this.parameterMappings[key]) {
          normalizedKey = this.parameterMappings[key];
        }
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[normalizedKey] = this.normalizeParameters(params[key] as OperationParams);
        } else {
          result[normalizedKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};
    
    for (const key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        // Convert camelCase to snake_case
        const snakeKey = this.reverseParameterMappings[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        
        // Handle nested objects recursively
        if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
          result[snakeKey] = this.convertCamelToSnakeCase(params[key] as OperationParams);
        } else {
          result[snakeKey] = params[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors. Also returns script errors and script warnings (file, line, message, count) parsed from Godot output, with repeated messages grouped.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'check_script',
          description: 'Check one GDScript file for parse and compile errors, loading it in the project context (autoloads and global classes resolve). Returns each error with its file and line, without running the game.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Path to the .gd file, relative to the project (e.g., "scripts/player.gd")',
              },
            },
            required: ['projectPath', 'scriptPath'],
          },
        },
        {
          name: 'check_project_scripts',
          description: 'Check every GDScript file in a Godot project for parse and compile errors, in the project context (autoloads and global classes resolve), without running the game. One Godot process checks the whole project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_tests',
          description: 'Run the project GUT tests headless and return structured results: totals, each failing test with its message, and script errors. Imports the project first unless importFirst is false. The call waits until the run finishes, which can take minutes on large suites. A full run is saved so that rerunFailed can rerun only its failing files, and junitPath writes the results for CI.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              directory: {
                type: 'string',
                description: 'Test directory as a res:// path (default res://test). Subdirectories are included.',
              },
              select: {
                type: 'string',
                description: 'Only run test scripts whose file name contains this text',
              },
              testName: {
                type: 'string',
                description: 'Only run tests whose name contains this text',
              },
              importFirst: {
                type: 'boolean',
                description: 'Import the project before running the tests (default true)',
              },
              timeoutMs: {
                type: 'number',
                description: 'Maximum time to wait for the run, in milliseconds (default 600000, max 3600000)',
              },
              rerunFailed: {
                type: 'boolean',
                description: 'Rerun only the test files that failed in the last full run of this project, and update those results. Cannot be combined with directory, select or testName.',
              },
              junitPath: {
                type: 'string',
                description: 'Also write the results as a JUnit XML file at this path inside the project, such as reports/junit.xml. CI test reporters, including GitHub Actions, read this format.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'diagnose_project',
          description: 'Diagnose a Godot project: the Godot executable and version, whether the project is imported, importable assets that have no .import file (which makes load_sprite and other tools fail), and .import files whose outputs are missing. Read-only unless runImport is true.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              runImport: {
                type: 'boolean',
                description: 'Import the project first (godot --headless --import). This writes .import files and the import cache. Default false.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'read_scene',
          description: 'Read an existing .tscn scene as a tree of nodes, with each node\'s type, path (for example "root/Player") and properties, plus its external and sub-resources. Read-only; does not need Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the .tscn file, relative to the project (e.g., "scenes/main.tscn")',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'set_node_property',
          description: 'Set one property on a node of an existing scene and save the scene. The value is a Godot literal, such as 42, true, "text", or Vector2(1, 2). The node is named by its path, such as "root/Player". Requires Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the .tscn file, relative to the project',
              },
              nodePath: {
                type: 'string',
                description: 'Path of the node inside the scene, starting with the root name (e.g., "root/Player")',
              },
              property: {
                type: 'string',
                description: 'Property name, such as position or texture',
              },
              value: {
                type: 'string',
                description: 'Godot literal for the new value, such as 42, true, "text", or Vector2(1, 2)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'property', 'value'],
          },
        },
        {
          name: 'install_editor_bridge',
          description: 'Install the Godot MCP Bridge editor plugin into a project: copies addons/godot_mcp_bridge and enables it in project.godot. Lets the server drive the project while it is open in the Godot editor. Changes the project: run it only when the user asks. Open the project in the editor afterwards so the plugin loads.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'editor_status',
          description: 'Check whether the project is open in the Godot editor with the Godot MCP Bridge enabled, and report the editor version, the open scene and whether a scene is playing.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'editor_command',
          description: 'Run one command in the open Godot editor through the Godot MCP Bridge. Commands: status, scene_tree, open_scene (path), save_scene, get_property (node_path, property), set_property (node_path, property, value as a Godot literal), add_node (parent_path, type, name), undo, redo, play (mode: main, current, custom with path, or probe with an optional scene; probe returns a session), stop, refresh_filesystem, probe_status (session: state of the probe for that run), probe_capture (id and session, taken from probe_status: asks the probe for a screenshot). Changes made this way go through the editor undo history. Node paths start with the scene root name, such as "root/Player".',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              command: {
                type: 'string',
                enum: EDITOR_BRIDGE_COMMANDS,
                description: 'The editor command to run',
              },
              arguments: {
                type: 'object',
                description: 'Arguments of the command, as described above',
              },
            },
            required: ['projectPath', 'command'],
          },
        },
        {
          name: 'verify_game',
          description: 'Check that a scene really runs in the Godot editor that has the bridge open: play it with the probe, confirm the frame counter keeps advancing during durationMs, take a screenshot, collect the runtime errors Godot reports, and stop the game. A game that freezes shows as not advancing. Needs install_editor_bridge and the project open in the editor.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'res:// path of the scene to run. Defaults to the scene open in the editor, which must be saved.',
              },
              durationMs: {
                type: 'number',
                description: 'How long to watch the frame counter, from 500 to 60000 ms. Default 3000.',
              },
              capture: {
                type: 'boolean',
                description: 'Take a screenshot of the game. Default true.',
              },
            },
            required: ['projectPath'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const scoped = this.scopeProjectPaths(request.params.name, request.params.arguments);
      if ('error' in scoped) {
        return scoped.error;
      }
      request.params.arguments = scoped.args;
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return (await this.handleInheritedScene('add_node', request.params.arguments)) ?? (await this.handleAddNode(request.params.arguments));
        case 'load_sprite':
          return (await this.handleInheritedScene('load_sprite', request.params.arguments)) ?? (await this.handleLoadSprite(request.params.arguments));
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return (await this.handleInheritedScene('save_scene', request.params.arguments)) ?? (await this.handleSaveScene(request.params.arguments));
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'check_script':
          return await this.handleCheckScript(request.params.arguments);
        case 'check_project_scripts':
          return await this.handleCheckProjectScripts(request.params.arguments);
        case 'run_tests':
          return await this.handleRunTests(request.params.arguments);
        case 'diagnose_project':
          return await this.handleDiagnoseProject(request.params.arguments);
        case 'install_editor_bridge':
          return await this.handleInstallEditorBridge(request.params.arguments);
        case 'editor_status':
          return await this.handleEditorStatus(request.params.arguments);
        case 'editor_command':
          return await this.handleEditorCommand(request.params.arguments);
        case 'verify_game':
          return await this.handleVerifyGame(request.params.arguments);
        case 'read_scene':
          return await this.handleReadScene(request.params.arguments);
        case 'set_node_property':
          return (await this.handleInheritedScene('set_node_property', request.params.arguments)) ?? (await this.handleSetNodeProperty(request.params.arguments));
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Append lines to one stream of a running Godot process and keep only the most recent
   * MAX_BUFFERED_LINES. Script errors in the lines being dropped are archived first.
   */
  private appendBufferedLines(session: GodotProcess, stream: 'output' | 'errors', lines: string[]): void {
    const buffer = session[stream];
    buffer.push(...lines);

    const excess = buffer.length - MAX_BUFFERED_LINES;
    if (excess <= 0) {
      return;
    }

    // Cut at the start of an error block when one is near the cut point. Otherwise the
    // dropped part would end in the middle of a block, and the block could not be archived.
    let cut = excess;
    for (let i = excess; i < buffer.length; i++) {
      if (/^\s*(?:SCRIPT )?(?:ERROR|WARNING): /.test(buffer[i])) {
        cut = i;
        break;
      }
    }

    const dropped = buffer.splice(0, cut);
    if (stream === 'output') {
      session.droppedOutputLines += dropped.length;
    } else {
      session.droppedErrorLines += dropped.length;
    }

    session.archivedScriptErrors.push(...this.parseScriptErrors(dropped.join('\n')));
    if (session.archivedScriptErrors.length > MAX_ARCHIVED_SCRIPT_ERRORS) {
      session.archivedScriptErrors.splice(0, session.archivedScriptErrors.length - MAX_ARCHIVED_SCRIPT_ERRORS);
    }

    session.archivedScriptWarnings.push(...this.parseScriptWarnings(dropped.join('\n')));
    if (session.archivedScriptWarnings.length > MAX_ARCHIVED_SCRIPT_ERRORS) {
      session.archivedScriptWarnings.splice(0, session.archivedScriptWarnings.length - MAX_ARCHIVED_SCRIPT_ERRORS);
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Make sure a Godot executable is known before spawning it
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
      const session: GodotProcess = {
        process,
        output: [],
        errors: [],
        droppedOutputLines: 0,
        droppedErrorLines: 0,
        archivedScriptErrors: [],
        archivedScriptWarnings: [],
      };

      process.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        this.appendBufferedLines(session, 'output', lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        this.appendBufferedLines(session, 'errors', lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess && this.activeProcess.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = session;

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Group repeated script errors (same file, line and message) with a count, and cap
   * the list. Runtime errors can repeat every frame, so this keeps responses short.
   */
  private groupScriptErrors(
    errors: { file: string; line: number; message: string }[],
    limit = 50
  ): {
    scriptErrors: { file: string; line: number; message: string; count: number }[];
    scriptErrorsOmitted: number;
  } {
    const groups = new Map<string, { file: string; line: number; message: string; count: number }>();
    for (const error of errors) {
      const key = `${error.file}:${error.line}:${error.message}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { ...error, count: 1 });
      }
    }
    const all = [...groups.values()];
    return {
      scriptErrors: all.slice(0, limit),
      scriptErrorsOmitted: Math.max(0, all.length - limit),
    };
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    const scriptErrors = this.groupScriptErrors([
      ...this.activeProcess.archivedScriptErrors,
      ...this.parseScriptErrors([...this.activeProcess.output, ...this.activeProcess.errors].join('\n')),
    ]);
    const scriptWarnings = this.groupScriptErrors([
      ...this.activeProcess.archivedScriptWarnings,
      ...this.parseScriptWarnings([...this.activeProcess.output, ...this.activeProcess.errors].join('\n')),
    ]);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
              droppedOutputLines: this.activeProcess.droppedOutputLines,
              droppedErrorLines: this.activeProcess.droppedErrorLines,
              ...scriptErrors,
              scriptWarnings: scriptWarnings.scriptErrors,
              scriptWarningsOmitted: scriptWarnings.scriptErrorsOmitted,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    const scriptErrors = this.groupScriptErrors([
      ...this.activeProcess.archivedScriptErrors,
      ...this.parseScriptErrors([...output, ...errors].join('\n')),
    ]);
    const scriptWarnings = this.groupScriptErrors([
      ...this.activeProcess.archivedScriptWarnings,
      ...this.parseScriptWarnings([...output, ...errors].join('\n')),
    ]);
    const droppedOutputLines = this.activeProcess.droppedOutputLines;
    const droppedErrorLines = this.activeProcess.droppedErrorLines;
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
              droppedOutputLines,
              droppedErrorLines,
              ...scriptErrors,
              scriptWarnings: scriptWarnings.scriptErrors,
              scriptWarningsOmitted: scriptWarnings.scriptErrorsOmitted,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Turn Godot's script error output into structured errors. Covers three forms:
   * - compile-time errors from --check-only:
   *     SCRIPT ERROR: Parse Error: <message>
   *        at: GDScript::reload (res://path/file.gd:<line>)
   * - runtime errors while the game runs:
   *     SCRIPT ERROR: <message>
   *        at: _ready (res://path/file.gd:<line>)
   * - push_error() calls, where the location is the first backtrace frame:
   *     ERROR: <message>
   *        at: push_error (core/...)
   *        GDScript backtrace (most recent call first):
   *            [0] _process (res://path/file.gd:<line>)
   */
  private parseScriptErrors(output: string): { file: string; line: number; message: string }[] {
    // SCRIPT ERROR blocks: the location is on the "at:" line.
    const scriptPattern = /SCRIPT ERROR: (?:(?:Parse|Compile) Error: )?(.+?)\r?\n\s*at: [^\n]*?\((res:\/\/[^\s:)]+):(\d+)\)/g;
    // push_error() blocks: not prefixed by SCRIPT, and the location is on the first backtrace frame.
    // Engine errors without a script frame do not match, so they are not reported as script errors.
    const pushPattern = /(?<!SCRIPT )ERROR: (.+?)\r?\n\s*at: [^\n]*\r?\n\s*GDScript backtrace[^\n]*\r?\n\s*\[0\] [^\n]*?\((res:\/\/[^\s:)]+):(\d+)\)/g;

    const found: { index: number; error: { file: string; line: number; message: string } }[] = [];
    for (const pattern of [scriptPattern, pushPattern]) {
      for (const match of output.matchAll(pattern)) {
        found.push({
          index: match.index ?? 0,
          error: { message: match[1].trim(), file: match[2], line: Number(match[3]) },
        });
      }
    }
    // Keep the order in which Godot printed the errors.
    return found.sort((a, b) => a.index - b.index).map((f) => f.error);
  }

  /**
   * Turn Godot's WARNING output into structured warnings. Warnings from scripts look like:
   *   WARNING: <message>
   *   at: GDScript::reload (res://path/file.gd:<line>)
   * Warnings without a script location (engine warnings) do not match.
   */
  private parseScriptWarnings(output: string): { file: string; line: number; message: string }[] {
    const pattern = /(?<!SCRIPT )WARNING: (.+?)\r?\n\s*at: [^\n]*?\((res:\/\/[^\s:)]+):(\d+)\)/g;
    const warnings: { file: string; line: number; message: string }[] = [];
    for (const match of output.matchAll(pattern)) {
      warnings.push({ message: match[1].trim(), file: match[2], line: Number(match[3]) });
    }
    return warnings;
  }

  /**
   * Load one script (resScriptPath), or every script in the project when it is omitted,
   * with scripts/check_scripts.gd. That runs after the project's autoloads are registered,
   * so the checks match the context the game uses: autoload names and global classes resolve.
   * executeOperation ignores the exit code, so this calls execFileAsync directly.
   */
  private async runCheckOnly(
    projectPath: string,
    resScriptPath?: string
  ): Promise<{
    ok: boolean;
    errors: { file: string; line: number; message: string }[];
    rawOutput: string;
    checkedCount: number;
    // Set when Godot could not be started at all (for example, a wrong GODOT_PATH).
    executionError?: string;
  }> {
    const userArgs = resScriptPath ? [resScriptPath] : [];
    let output = '';
    let exitCode = 0;
    try {
      const { stdout, stderr } = await execFileAsync(
        this.godotPath!,
        ['--headless', '--path', projectPath, '--script', this.checkScriptsPath, '--', ...userArgs],
        { timeout: 900000, maxBuffer: 64 * 1024 * 1024 }
      );
      output = `${stdout ?? ''}\n${stderr ?? ''}`;
    } catch (error: any) {
      // A numeric code is Godot's exit status. A string code (such as ENOENT) means
      // the executable could not be started, so there is no script result to report.
      if (typeof error?.code !== 'number') {
        return {
          ok: false,
          errors: [],
          rawOutput: '',
          checkedCount: 0,
          executionError: error?.message || 'Unknown error starting Godot',
        };
      }
      exitCode = error.code;
      output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    }

    const errors = this.parseScriptErrors(output);
    // A file Godot cannot load at all has no SCRIPT ERROR line; report it as an error too.
    for (const match of output.matchAll(/CHECK_FAIL (res:\/\/\S+)/g)) {
      if (!errors.some((e) => e.file === match[1])) {
        errors.push({ file: match[1], line: 0, message: 'Godot could not load this file' });
      }
    }
    const checkedCount = Number(/CHECK_DONE total=(\d+)/.exec(output)?.[1] ?? 0);
    return {
      ok: exitCode === 0 && errors.length === 0,
      errors,
      rawOutput: output.trim(),
      checkedCount,
    };
  }

  /**
   * Describe a failed check. Use the parsed errors when there are any; otherwise
   * show Godot's raw output so the failure is not hidden, under an accurate heading.
   */
  private formatCheckFailure(
    label: string,
    result: { errors: { file: string; line: number; message: string }[]; rawOutput: string }
  ): string {
    if (result.errors.length > 0) {
      const lines = result.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n');
      return `Parse errors in ${label}:\n${lines}`;
    }
    // Drop Godot's version banner and blank lines so the useful lines come first.
    const useful = result.rawOutput
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.startsWith('Godot Engine v'))
      .join('\n');
    return `Godot could not check ${label}:\n${useful ? useful.slice(0, 1500) : '(Godot printed no output)'}`;
  }

  /**
   * Handle the check_script tool: parse-check one GDScript file.
   */
  private async handleCheckScript(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.scriptPath) {
      return this.createErrorResponse(
        'Project path and script path are required',
        ['Provide projectPath and scriptPath (relative to the project, ending in .gd)']
      );
    }

    // validatePath expects strings; a number or object here would throw an internal error.
    if (typeof args.projectPath !== 'string' || typeof args.scriptPath !== 'string') {
      return this.createErrorResponse(
        'Project path and script path must be text',
        ['Provide projectPath and scriptPath as strings']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scriptPath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const scriptPath = String(args.scriptPath).replace(/\\/g, '/').replace(/^res:\/\//, '');
    if (!scriptPath.endsWith('.gd')) {
      return this.createErrorResponse(
        `Not a GDScript file: ${scriptPath}`,
        ['Only .gd files can be checked']
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    const absoluteScript = resolvePath(projectRoot, scriptPath);
    const relativeScript = relative(projectRoot, absoluteScript).replace(/\\/g, '/');
    if (relativeScript.split('/')[0] === '..' || isAbsolute(relativeScript)) {
      return this.createErrorResponse(
        'Script path must be inside the project',
        ['Use a path relative to the project directory']
      );
    }

    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    if (!existsSync(absoluteScript)) {
      return this.createErrorResponse(
        `Script not found: ${relativeScript}`,
        ['Check the path relative to the project directory']
      );
    }

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug(`Checking script: ${relativeScript}`);
      const result = await this.runCheckOnly(projectRoot, `res://${relativeScript}`);
      if (result.executionError) {
        return this.createErrorResponse(
          `Failed to run Godot: ${result.executionError}`,
          [
            'Set GODOT_PATH to the full path of a Godot executable',
            'Check that Godot runs from a terminal with --version',
          ]
        );
      }

      if (result.ok) {
        return {
          content: [{ type: 'text', text: `OK: ${relativeScript} has no parse errors.` }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: this.formatCheckFailure(relativeScript, result),
          },
        ],
        isError: true,
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to check script: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed and GODOT_PATH is set correctly']
      );
    }
  }

  /**
   * Handle the check_project_scripts tool: parse-check every .gd file in a project.
   */
  private async handleCheckProjectScripts(args: any) {
    args = this.normalizeParameters(args);

    // validatePath expects a string; reject other types before it runs.
    if (args.projectPath !== undefined && typeof args.projectPath !== 'string') {
      return this.createErrorResponse(
        'Project path must be text',
        ['Provide projectPath as a string']
      );
    }

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // One Godot process checks the whole project, with the autoloads registered.
      const result = await this.runCheckOnly(projectRoot);
      if (result.executionError) {
        return this.createErrorResponse(
          `Failed to run Godot: ${result.executionError}`,
          [
            'Set GODOT_PATH to the full path of a Godot executable',
            'Check that Godot runs from a terminal with --version',
          ]
        );
      }
      if (result.checkedCount === 0 && result.errors.length === 0) {
        return {
          content: [{ type: 'text', text: 'No GDScript files found in the project.' }],
        };
      }
      if (result.ok) {
        return {
          content: [{ type: 'text', text: `OK: checked ${result.checkedCount} GDScript files, no parse errors.` }],
        };
      }

      // Group the errors by file, in the order Godot reported them.
      const byFile = new Map<string, { file: string; line: number; message: string }[]>();
      for (const error of result.errors) {
        const list = byFile.get(error.file) ?? [];
        list.push(error);
        byFile.set(error.file, list);
      }
      if (byFile.size === 0) {
        // Godot failed without a recognized error: show its output instead of hiding it.
        return {
          content: [{ type: 'text', text: this.formatCheckFailure('the project', result) }],
          isError: true,
        };
      }
      const details = [...byFile.entries()]
        .map(([file, errors]) => this.formatCheckFailure(file.replace('res://', ''), { errors, rawOutput: '' }))
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: `Checked ${result.checkedCount} GDScript files: ${byFile.size} with errors.\n\n${details}`,
          },
        ],
        isError: true,
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to check project scripts: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed and GODOT_PATH is set correctly']
      );
    }
  }

  /**
   * Parse the JUnit XML that GUT writes (-gjunit_xml_file). Each test is a <testcase>
   * with a status attribute (pass, fail or pending). Failing and pending tests carry
   * their message in a CDATA section. The format is fixed, so a small parser is enough.
   */
  private parseJunitXml(xml: string): {
    tests: { suite: string; name: string; status: string; time: number; message?: string }[];
  } {
    const decode = (value: string): string =>
      value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    const tests: { suite: string; name: string; status: string; time: number; message?: string }[] = [];
    for (const match of xml.matchAll(/<testcase\s+([^>]*?)>([\s\S]*?)<\/testcase>/g)) {
      const attributes: Record<string, string> = {};
      for (const attr of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
        attributes[attr[1]] = decode(attr[2]);
      }
      const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(match[2]);
      tests.push({
        suite: attributes.classname ?? '',
        name: attributes.name ?? '',
        status: attributes.status ?? 'unknown',
        time: Number(attributes.time) || 0,
        message: cdata ? cdata[1].trim() : undefined,
      });
    }
    return { tests };
  }

  /**
   * Run `godot --headless --import` so resources are imported before the tests run.
   * Returns the output when Godot exits with an error, or undefined when it succeeds.
   */
  private async runGodotImport(projectRoot: string): Promise<string | undefined> {
    try {
      await execFileAsync(this.godotPath!, ['--headless', '--path', projectRoot, '--import'], {
        timeout: 300000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return undefined;
    } catch (error: any) {
      if (typeof error?.code !== 'number') {
        throw error;
      }
      return `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim() || `Godot exited with code ${error.code}`;
    }
  }

  /**
   * Run GUT once and write its JUnit XML to a temporary directory outside the project.
   * The exit code is not enough on its own: GUT can exit with 0 when no tests ran.
   */
  private async runGutTests(
    projectRoot: string,
    options: { directory: string; select?: string; testName?: string; timeoutMs: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; junitXml?: string }> {
    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-gut-'));
    const junitPath = join(tempDir, 'results.xml');
    try {
      const gutArgs = [
        '--headless',
        '--path',
        projectRoot,
        '-s',
        'addons/gut/gut_cmdln.gd',
        `-gdir=${options.directory}`,
        '-ginclude_subdirs',
        '-gexit',
        '-gdisable_colors',
        `-gjunit_xml_file=${junitPath}`,
      ];
      if (options.select) {
        gutArgs.push(`-gselect=${options.select}`);
      }
      if (options.testName) {
        gutArgs.push(`-gunit_test_name=${options.testName}`);
      }

      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let timedOut = false;
      try {
        const result = await execFileAsync(this.godotPath!, gutArgs, {
          timeout: options.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
      } catch (error: any) {
        if (error?.killed) {
          timedOut = true;
          exitCode = -1;
        } else if (typeof error?.code === 'number') {
          exitCode = error.code;
        } else {
          throw error;
        }
        stdout = error?.stdout ?? '';
        stderr = error?.stderr ?? '';
      }

      const junitXml = existsSync(junitPath) ? readFileSync(junitPath, 'utf8') : undefined;
      return { stdout, stderr, exitCode, timedOut, junitXml };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** The last full run_tests result of a project, or undefined when there is none or it cannot be read. */
  private readTestState(projectRoot: string): TestState | undefined {
    const file = join(projectRoot, '.godot', 'mcp_tests_last.json');
    if (!existsSync(file)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed?.directory === 'string' && Array.isArray(parsed?.tests)) {
        return parsed as TestState;
      }
    } catch {
      // A damaged file counts as no earlier result.
    }
    return undefined;
  }

  private writeTestState(projectRoot: string, state: TestState): void {
    mkdirSync(join(projectRoot, '.godot'), { recursive: true });
    writeFileSync(join(projectRoot, '.godot', 'mcp_tests_last.json'), JSON.stringify(state, null, 2));
  }

  /** Write the results as a JUnit XML file, the format CI test reporters such as GitHub Actions read. */
  private writeJunitFile(projectRoot: string, relPath: string, tests: TestRecord[]): void {
    const target = join(projectRoot, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, this.buildJunitXml(tests));
  }

  private buildJunitXml(tests: TestRecord[]): string {
    const attr = (value: string): string =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cdata = (value: string): string => value.replace(/]]>/g, ']]]]><![CDATA[>');
    const seconds = (value: number): string => (Number.isFinite(value) ? value : 0).toFixed(6);
    const count = (list: TestRecord[], status: string): number => list.filter((t) => t.status === status).length;
    const total = (list: TestRecord[]): number => list.reduce((sum, t) => sum + (Number.isFinite(t.time) ? t.time : 0), 0);

    const suites = new Map<string, TestRecord[]>();
    for (const test of tests) {
      suites.set(test.suite, [...(suites.get(test.suite) ?? []), test]);
    }

    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="GutTests" tests="${tests.length}" failures="${count(tests, 'fail')}" skipped="${count(tests, 'pending')}" time="${seconds(total(tests))}">`,
    ];
    for (const [suite, list] of suites) {
      lines.push(`  <testsuite name="${attr(suite)}" tests="${list.length}" failures="${count(list, 'fail')}" skipped="${count(list, 'pending')}" time="${seconds(total(list))}">`);
      for (const test of list) {
        lines.push(`    <testcase name="${attr(test.name)}" classname="${attr(test.suite)}" time="${seconds(test.time)}">`);
        if (test.status === 'fail') {
          lines.push(`      <failure message="failed"><![CDATA[${cdata(test.message ?? 'failed')}]]></failure>`);
        } else if (test.status === 'pending') {
          lines.push(`      <skipped message="pending"><![CDATA[${cdata(test.message ?? '')}]]></skipped>`);
        }
        lines.push('    </testcase>');
      }
      lines.push('  </testsuite>');
    }
    lines.push('</testsuites>');
    return lines.join('\n') + '\n';
  }

  /**
   * Rerun only the test files that failed in the last full run, then update those tests in the saved result.
   * GUT's -gselect matches file names, so each failing file runs once by its name. Only the tests that
   * failed before are taken from the rerun; the rest of the last full run stays as it was.
   */
  private async rerunFailedTests(
    projectRoot: string,
    previous: TestState,
    timeoutMs: number,
    junitRelPath?: string
  ): Promise<any> {
    const tests: TestRecord[] = previous.tests.map((t) => ({ ...t }));
    const failedBefore: TestRecord[] = tests.filter((t) => t.status === 'fail').map((t) => ({ ...t }));
    const files = [...new Set(failedBefore.map((t) => t.suite))];
    const outputs: string[] = [];

    for (const file of files) {
      const fileName = file.split('/').pop() ?? file;
      const run = await this.runGutTests(projectRoot, { directory: previous.directory, select: fileName, timeoutMs });
      if (run.timedOut) {
        return this.createErrorResponse(
          `The rerun of ${file} did not finish within ${timeoutMs} ms`,
          ['Increase timeoutMs, or run the full suite without rerunFailed'],
          { code: 'TIMEOUT' }
        );
      }
      outputs.push(`${run.stdout}\n${run.stderr}`);
      const fresh = run.junitXml ? this.parseJunitXml(run.junitXml).tests : [];
      for (const test of tests) {
        if (test.status !== 'fail' || test.suite !== file) {
          continue;
        }
        const again = fresh.find((f) => f.suite === file && f.name === test.name);
        if (again) {
          test.status = again.status;
          test.time = again.time;
          test.message = again.message;
        } else {
          test.message = 'Not found when rerunning this file; run the full suite again';
        }
      }
    }

    const nowPassing = tests.filter(
      (t) => t.status === 'pass' && failedBefore.some((b) => b.suite === t.suite && b.name === t.name)
    ).length;
    const passed = tests.filter((t) => t.status === 'pass').length;
    const failures = tests.filter((t) => t.status === 'fail');
    const pendingTests = tests.filter((t) => t.status === 'pending');
    const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(outputs.join('\n')));
    this.writeTestState(projectRoot, { directory: previous.directory, savedAt: new Date().toISOString(), tests });
    if (junitRelPath) {
      this.writeJunitFile(projectRoot, junitRelPath, tests);
    }

    const summary: string[] = [
      files.length === 0
        ? 'No failing tests in the last full run, so nothing was rerun.'
        : `Reran ${files.length} file(s) with failures: ${failedBefore.length} test(s) rechecked, ${nowPassing} now passing, ${failures.length} still failing.`,
      `Last full run: ${tests.length} tests | passed: ${passed} | failed: ${failures.length} | pending: ${pendingTests.length}`,
    ];
    if (failures.length > 0) {
      summary.push('', 'Failures:');
      for (const failure of failures) {
        summary.push(`- ${failure.suite}::${failure.name}`);
        if (failure.message) {
          summary.push(`    ${failure.message.split(/\r?\n/).slice(0, 3).join('\n    ').slice(0, 300)}`);
        }
      }
    }
    if (scriptErrors.scriptErrors.length > 0) {
      summary.push('', 'Script errors:');
      for (const error of scriptErrors.scriptErrors) {
        summary.push(`- ${error.file}:${error.line}: ${error.message}${error.count > 1 ? ` (x${error.count})` : ''}`);
      }
    }

    const details = {
      rerun: { files, rechecked: failedBefore.length, nowPassing, stillFailing: failures.length },
      total: tests.length,
      passed,
      failed: failures.length,
      pending: pendingTests.length,
      failures: failures.map((f) => ({ suite: f.suite, name: f.name, message: f.message?.slice(0, 2000), time: f.time })),
      pendingTests: pendingTests.map((p) => ({ suite: p.suite, name: p.name })),
      scriptErrors: scriptErrors.scriptErrors,
      scriptErrorsOmitted: scriptErrors.scriptErrorsOmitted,
      junitPath: junitRelPath,
    };

    return {
      content: [
        { type: 'text', text: summary.join('\n') },
        { type: 'text', text: JSON.stringify(details, null, 2) },
      ],
      isError: failures.length > 0 || scriptErrors.scriptErrors.length > 0,
    };
  }

  /**
   * Handle the run_tests tool: run the GUT tests and return structured results.
   */
  private async handleRunTests(args: any) {
    args = this.normalizeParameters(args);

    if (typeof args.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory'],
        { code: 'INVALID_ARGUMENT' }
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters'],
        { code: 'INVALID_PATH' }
      );
    }

    for (const key of ['directory', 'select', 'testName', 'junitPath']) {
      if (args[key] !== undefined && typeof args[key] !== 'string') {
        return this.createErrorResponse(`${key} must be text`, ['Provide it as a string'], { code: 'INVALID_ARGUMENT' });
      }
    }

    const rerunFailed = args.rerunFailed === true;
    if (rerunFailed && (args.directory !== undefined || args.select !== undefined || args.testName !== undefined)) {
      return this.createErrorResponse(
        'rerunFailed cannot be combined with directory, select or testName',
        ['Use rerunFailed alone, or run the tests with the filters you need'],
        { code: 'INVALID_ARGUMENT' }
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ],
        { code: 'PROJECT_NOT_FOUND' }
      );
    }

    let junitRelPath: string | undefined;
    if (args.junitPath !== undefined) {
      const resolved = this.resolveInsideProject(args.projectPath, args.junitPath);
      if ('error' in resolved) {
        return this.createErrorResponse(
          `junitPath: ${resolved.error}`,
          ['Give a path inside the project, such as reports/junit.xml'],
          { code: 'INVALID_PATH' }
        );
      }
      junitRelPath = resolved.relPath;
    }

    // rerunFailed works from the result of the last full run, so it has no directory of its own to check.
    const previous = rerunFailed ? this.readTestState(projectRoot) : undefined;
    if (rerunFailed && !previous) {
      return this.createErrorResponse(
        'There is no earlier run_tests result in this project to rerun',
        ['Run run_tests without rerunFailed first'],
        { code: 'INVALID_ARGUMENT' }
      );
    }

    const directory = previous ? previous.directory : String(args.directory ?? 'res://test').replace(/\\/g, '/');
    if (!previous) {
      if (!directory.startsWith('res://') || directory.includes('..')) {
        return this.createErrorResponse(
          `Invalid test directory: ${directory}`,
          ['Use a res:// path such as res://test'],
          { code: 'INVALID_ARGUMENT' }
        );
      }
      const directoryOnDisk = join(projectRoot, directory.slice('res://'.length));
      if (!existsSync(directoryOnDisk) || !statSync(directoryOnDisk).isDirectory()) {
        return this.createErrorResponse(
          `Test directory not found: ${directory}`,
          ['Check the directory relative to the project root'],
          { code: 'TEST_DIRECTORY_NOT_FOUND' }
        );
      }
    }

    const requestedTimeout = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 600000;
    const timeoutMs = Math.min(requestedTimeout, 3600000);

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ],
            { code: 'GODOT_NOT_FOUND' }
          );
        }
      }

      if (args.importFirst !== false) {
        const importOutput = await this.runGodotImport(projectRoot);
        if (importOutput !== undefined) {
          return this.createErrorResponse(
            `Godot import failed:\n${importOutput.slice(0, 1500)}`,
            ['Open the project in the Godot editor to see the import errors', 'Run again with importFirst set to false if the project is already imported'],
            { code: 'IMPORT_FAILED' }
          );
        }
      }

      if (previous) {
        return await this.rerunFailedTests(projectRoot, previous, timeoutMs, junitRelPath);
      }

      this.logDebug(`Running GUT tests in ${directory}`);
      const run = await this.runGutTests(projectRoot, {
        directory,
        select: args.select,
        testName: args.testName,
        timeoutMs,
      });

      if (run.timedOut) {
        return this.createErrorResponse(
          `The tests did not finish within ${timeoutMs} ms`,
          ['Increase timeoutMs, or narrow the run with select or testName'],
          { code: 'TIMEOUT' }
        );
      }

      const output = `${run.stdout}\n${run.stderr}`;
      const gutError = output.split(/\r?\n/).find((line) => line.includes('[GUT ERROR]'));

      if (!run.junitXml) {
        return this.createErrorResponse(
          `GUT did not write results.${gutError ? ` ${gutError.trim()}` : ''}`,
          [
            'Check that the test directory contains GUT test scripts (test_*.gd)',
            'Check the select and testName filters',
          ],
          { code: 'TESTS_NOT_RUN' }
        );
      }

      const parsed = this.parseJunitXml(run.junitXml);
      if (parsed.tests.length === 0) {
        return this.createErrorResponse(
          'No tests were run',
          ['Check that the test directory contains GUT test scripts (test_*.gd)', 'Check the select and testName filters'],
          { code: 'TESTS_NOT_RUN' }
        );
      }

      // A full run becomes the result that rerunFailed works from. A filtered run leaves that result as it was.
      const filtered = args.select !== undefined || args.testName !== undefined;
      if (!filtered) {
        this.writeTestState(projectRoot, { directory, savedAt: new Date().toISOString(), tests: parsed.tests });
      }
      if (junitRelPath) {
        this.writeJunitFile(projectRoot, junitRelPath, parsed.tests);
      }

      const failures = parsed.tests.filter((t) => t.status === 'fail');
      const pendingTests = parsed.tests.filter((t) => t.status === 'pending');
      const passed = parsed.tests.filter((t) => t.status === 'pass').length;
      const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(output));

      const summary = [
        `Tests: ${parsed.tests.length} | passed: ${passed} | failed: ${failures.length} | pending: ${pendingTests.length}`,
      ];
      if (failures.length > 0) {
        summary.push('', 'Failures:');
        for (const failure of failures) {
          summary.push(`- ${failure.suite}::${failure.name}`);
          if (failure.message) {
            summary.push(`    ${failure.message.split(/\r?\n/).slice(0, 3).join('\n    ').slice(0, 300)}`);
          }
        }
      }
      if (scriptErrors.scriptErrors.length > 0) {
        summary.push('', 'Script errors:');
        for (const error of scriptErrors.scriptErrors) {
          summary.push(`- ${error.file}:${error.line}: ${error.message}${error.count > 1 ? ` (x${error.count})` : ''}`);
        }
      }
      if (gutError) {
        summary.push('', gutError.trim());
      }

      const details = {
        total: parsed.tests.length,
        passed,
        failed: failures.length,
        pending: pendingTests.length,
        failures: failures.map((f) => ({
          suite: f.suite,
          name: f.name,
          message: f.message?.slice(0, 2000),
          time: f.time,
        })),
        pendingTests: pendingTests.map((p) => ({ suite: p.suite, name: p.name })),
        scriptErrors: scriptErrors.scriptErrors,
        scriptErrorsOmitted: scriptErrors.scriptErrorsOmitted,
        exitCode: run.exitCode,
        junitPath: junitRelPath,
        savedForRerun: !filtered,
      };

      return {
        content: [
          { type: 'text', text: summary.join('\n') },
          { type: 'text', text: JSON.stringify(details, null, 2) },
        ],
        isError: run.exitCode !== 0 || failures.length > 0 || scriptErrors.scriptErrors.length > 0,
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to run tests: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed and GODOT_PATH is set correctly']
      );
    }
  }

  /**
   * Check that a path used for reading or writing stays inside the project folder.
   * Accepts a project-relative path, optionally prefixed with res://. Rejects absolute
   * paths, drive letters, paths that climb out with "..", and links inside the project
   * that lead outside it. Returns the normalized path relative to the project.
   */
  private resolveInsideProject(projectPath: string, value: unknown): { relPath: string } | { error: string } {
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: 'A path relative to the project is required' };
    }

    const projectRoot = resolvePath(projectPath);
    if (!existsSync(projectRoot)) {
      return { error: `Project directory does not exist: ${projectPath}` };
    }

    const cleaned = value.replace(/\\/g, '/').replace(/^res:\/\//, '');
    if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || isAbsolute(cleaned)) {
      return { error: `Path must be relative to the project, not absolute: ${value}` };
    }

    const target = resolvePath(projectRoot, cleaned);
    const rel = relative(projectRoot, target).replace(/\\/g, '/');
    if (rel === '' || rel === '..' || rel.startsWith('../')) {
      return { error: `Path is outside the project: ${value}` };
    }

    // A link inside the project must not lead outside it either. Check the nearest
    // existing ancestor, because the target itself may not exist yet.
    let existing = target;
    while (!existsSync(existing) && dirname(existing) !== existing) {
      existing = dirname(existing);
    }
    const realRel = relative(realpathSync(projectRoot), realpathSync(existing)).replace(/\\/g, '/');
    if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
      return { error: `Path leads outside the project through a link: ${value}` };
    }

    return { relPath: rel };
  }

  /**
   * Apply resolveInsideProject to every path parameter of a tool (see PROJECT_PATH_PARAMS).
   * Tools without path parameters, and invalid projectPath values, pass through unchanged so
   * the handler reports its own error.
   */
  private scopeProjectPaths(toolName: string, rawArgs: any): { args: any } | { error: any } {
    const pathParams = PROJECT_PATH_PARAMS[toolName];
    if (!pathParams) {
      return { args: rawArgs };
    }

    const args = this.normalizeParameters(rawArgs ?? {});
    if (typeof args.projectPath !== 'string' || !args.projectPath || !this.validatePath(args.projectPath)) {
      return { args };
    }

    for (const key of pathParams) {
      if (args[key] === undefined || args[key] === null || args[key] === '') {
        continue;
      }
      const result = this.resolveInsideProject(args.projectPath, args[key]);
      if ('error' in result) {
        return {
          error: this.createErrorResponse(result.error, [
            'Use a path relative to the project directory, for example scenes/main.tscn',
          ]),
        };
      }
      args[key] = result.relPath;
    }

    return { args };
  }

  /**
   * True when a scene inherits from another scene: its root node has no parent and an
   * instance= attribute. Instanced child nodes are not inheritance and are kept on save.
   */
  private isInheritedSceneFile(sceneFile: string): boolean {
    if (!existsSync(sceneFile)) {
      return false;
    }
    const rootHeader = readFileSync(sceneFile, 'utf8')
      .split(/\r?\n/)
      .find((line) => /^\[node\s/.test(line.trim()));
    if (!rootHeader) {
      return false;
    }
    return /\sinstance=/.test(rootHeader) && !/\sparent=/.test(rootHeader);
  }

  /**
   * List files under a directory whose extension is in the given list. Hidden entries
   * such as .godot/ and .git/ are skipped. Paths are relative to rootDir, with forward slashes.
   */
  private listProjectFiles(dir: string, rootDir: string, extensions: string[], found: string[] = []): string[] {
    if (!existsSync(dir)) {
      return found;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.listProjectFiles(fullPath, rootDir, extensions, found);
      } else if (entry.isFile()) {
        const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (extensions.includes(extension)) {
          found.push(relative(rootDir, fullPath).replace(/\\/g, '/'));
        }
      }
    }
    return found;
  }

  /**
   * Handle the diagnose_project tool: report what is needed for the project to load its resources.
   */
  private async handleDiagnoseProject(args: any) {
    args = this.normalizeParameters(args);

    if (typeof args.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    const checks: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[] = [];
    const add = (name: string, status: 'ok' | 'warn' | 'error', detail: string) => {
      checks.push({ name, status, detail });
    };

    // 1. Godot executable and version
    let godotVersion: string | undefined;
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        add('godot_executable', 'error', 'No Godot executable found. Set GODOT_PATH to its full path.');
      } else {
        const { stdout } = await execFileAsync(this.godotPath, ['--version']);
        godotVersion = stdout.trim();
        add('godot_executable', 'ok', this.godotPath);
        const major = Number(/^(\d+)/.exec(godotVersion)?.[1]);
        add(
          'godot_version',
          major === 4 ? 'ok' : 'warn',
          major === 4 ? godotVersion : `${godotVersion} (this server is written for Godot 4)`
        );
      }
    } catch (error: any) {
      add('godot_executable', 'error', error?.message || 'Could not run Godot --version');
    }

    // 2. project.godot
    const projectFile = join(projectRoot, 'project.godot');
    if (!existsSync(projectFile)) {
      add('project_file', 'error', `No project.godot in ${args.projectPath}`);
    } else {
      const name = /config\/name="([^"]*)"/.exec(readFileSync(projectFile, 'utf8'))?.[1];
      add('project_file', 'ok', name ? `Project "${name}"` : 'project.godot found');
    }

    // 3. Optional import run (writes .import files and the import cache)
    if (args.runImport === true && godotVersion && this.godotPath) {
      const importOutput = await this.runGodotImport(projectRoot);
      add(
        'import_run',
        importOutput === undefined ? 'ok' : 'error',
        importOutput === undefined ? 'Import finished without errors' : importOutput.slice(0, 300)
      );
    }

    // 4. Import cache
    const importedDir = join(projectRoot, '.godot', 'imported');
    const importedCount = existsSync(importedDir) ? readdirSync(importedDir).length : 0;
    add(
      'import_cache',
      importedCount > 0 ? 'ok' : 'warn',
      importedCount > 0 ? `${importedCount} entries in .godot/imported` : 'Nothing is imported yet (.godot/imported is empty or missing)'
    );

    // 5. Importable assets without a .import file
    const assets = this.listProjectFiles(projectRoot, projectRoot, IMPORTABLE_EXTENSIONS);
    const missingImport = assets.filter((asset) => !existsSync(join(projectRoot, `${asset}.import`)));
    add(
      'import_files',
      missingImport.length === 0 ? 'ok' : 'warn',
      missingImport.length === 0
        ? (assets.length === 0 ? 'No importable assets found' : `${assets.length} importable assets, all with a .import file`)
        : `${missingImport.length} of ${assets.length} importable assets have no .import file, so Godot cannot load them. Example: ${missingImport[0]}`
    );

    // 6. .import files whose imported output is missing
    const importFiles = this.listProjectFiles(projectRoot, projectRoot, ['import']);
    const brokenImports = importFiles.filter((file) => {
      const target = /^path="res:\/\/([^"]+)"/m.exec(readFileSync(join(projectRoot, file), 'utf8'))?.[1];
      return target !== undefined && !existsSync(join(projectRoot, target));
    });
    add(
      'import_outputs',
      brokenImports.length === 0 ? 'ok' : 'warn',
      brokenImports.length === 0
        ? `${importFiles.length} .import files with their outputs present`
        : `${brokenImports.length} .import files point to missing outputs, so they need re-importing. Example: ${brokenImports[0]}`
    );

    if ((missingImport.length > 0 || brokenImports.length > 0) && args.runImport !== true) {
      add('recommendation', 'warn', 'Run diagnose_project with runImport set to true, or run: godot --headless --path <project> --import');
    }

    const lines = checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}`);
    const details = {
      checks,
      importableAssets: assets.length,
      missingImport: missingImport.slice(0, 50),
      brokenImports: brokenImports.slice(0, 50),
    };

    return {
      content: [
        { type: 'text', text: lines.join('\n') },
        { type: 'text', text: JSON.stringify(details, null, 2) },
      ],
      isError: checks.some((c) => c.status === 'error'),
    };
  }

  /**
   * Parse the text of a .tscn file into its nodes, external resources and sub-resources.
   * Handles the format Godot writes: a section header with attributes, then "key = value"
   * lines that belong to the latest section. Each node's path is "<root>/<child>/...".
   */
  private parseSceneText(text: string): {
    format: string;
    root: SceneNodeInfo | null;
    nodeCount: number;
    extResources: { id: string; type: string; path: string }[];
    subResources: { id: string; type: string; properties: Record<string, string> }[];
    orphanNodes: string[];
    inheritsFrom: string | null;
    derived: { key: string; node: SceneNodeInfo }[];
  } {
    const parseAttributes = (raw: string): Record<string, string> => {
      const attributes: Record<string, string> = {};
      for (const match of raw.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g)) {
        attributes[match[1]] = match[2].replace(/^"|"$/g, '');
      }
      return attributes;
    };

    const nodes: SceneNodeInfo[] = [];
    const extResources: { id: string; type: string; path: string }[] = [];
    const subResources: { id: string; type: string; properties: Record<string, string> }[] = [];
    let format = '';
    let current: { properties: Record<string, string> } | null = null;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }

      const header = /^\[(\w+)(.*)\]$/.exec(line);
      if (header) {
        const kind = header[1];
        const attributes = parseAttributes(header[2]);
        current = null;

        if (kind === 'gd_scene') {
          format = attributes.format ?? '';
        } else if (kind === 'ext_resource') {
          extResources.push({ id: attributes.id ?? '', type: attributes.type ?? '', path: attributes.path ?? '' });
        } else if (kind === 'sub_resource') {
          const sub = { id: attributes.id ?? '', type: attributes.type ?? '', properties: {} as Record<string, string> };
          subResources.push(sub);
          current = sub;
        } else if (kind === 'node') {
          const node: SceneNodeInfo = {
            name: attributes.name ?? '',
            type: attributes.type ?? null,
            parent: attributes.parent ?? null,
            instance: attributes.instance ?? null,
            path: '',
            properties: {},
            children: [],
            origin: 'scene',
          };
          nodes.push(node);
          current = node;
        }
        continue;
      }

      const property = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
      if (property && current) {
        current.properties[property[1]] = property[2].slice(0, 300);
      }
    }

    const root = nodes.find((node) => node.parent === null) ?? null;
    const orphanNodes: string[] = [];
    if (root) {
      root.path = root.name;
      // Nodes are keyed by their path relative to the root; the root itself is ''.
      const byRelativePath = new Map<string, SceneNodeInfo>([['', root]]);
      for (const node of nodes) {
        if (node === root) {
          continue;
        }
        const parentKey = node.parent === '.' ? '' : (node.parent ?? '');
        const parentNode = byRelativePath.get(parentKey);
        if (!parentNode) {
          orphanNodes.push(node.name);
          continue;
        }
        const relativeKey = parentKey === '' ? node.name : `${parentKey}/${node.name}`;
        node.path = `${root.name}/${relativeKey}`;
        parentNode.children.push(node);
        byRelativePath.set(relativeKey, node);
      }
    }

    // The root's instance= attribute names the scene it inherits from (ExtResource("id")).
    let inheritsFrom: string | null = null;
    if (root && root.instance && root.parent === null) {
      const resourceId = /ExtResource\("([^"]+)"\)/.exec(root.instance)?.[1];
      const resourcePath = extResources.find((resource) => resource.id === resourceId)?.path;
      inheritsFrom = resourcePath ? resourcePath.replace(/^res:\/\//, '') : null;
    }
    const derived = nodes
      .filter((node) => node !== root)
      .map((node) => ({ key: sceneNodeKey(node.parent ?? undefined, node.name), node }));

    return { format, root, nodeCount: nodes.length, extResources, subResources, orphanNodes, inheritsFrom, derived };
  }

  /**
   * Read a scene. When it inherits from another scene, the base scene's nodes are merged in:
   * the base tree with this scene's overrides applied and its new nodes added. Each node
   * comes back with an origin ("scene", "inherited" or "overridden").
   */
  private readSceneTree(projectRoot: string, relPath: string, depth = 0): {
    format: string;
    root: SceneNodeInfo | null;
    nodeCount: number;
    extResources: { id: string; type: string; path: string }[];
    subResources: { id: string; type: string; properties: Record<string, string> }[];
    orphanNodes: string[];
    inheritsFrom: string | null;
  } {
    const parsed = this.parseSceneText(readFileSync(join(projectRoot, relPath), 'utf8'));
    const base =
      parsed.inheritsFrom && depth < 8 && existsSync(join(projectRoot, parsed.inheritsFrom))
        ? this.readSceneTree(projectRoot, parsed.inheritsFrom, depth + 1)
        : null;
    if (!base || !base.root) {
      return {
        format: parsed.format,
        root: parsed.root,
        nodeCount: parsed.nodeCount,
        extResources: parsed.extResources,
        subResources: parsed.subResources,
        orphanNodes: parsed.orphanNodes,
        inheritsFrom: parsed.inheritsFrom,
      };
    }

    const root = base.root;
    const index = new Map<string, SceneNodeInfo>();
    const markInherited = (node: SceneNodeInfo, key: string) => {
      node.origin = 'inherited';
      index.set(key, node);
      for (const child of node.children) {
        markInherited(child, key === '' ? child.name : `${key}/${child.name}`);
      }
    };
    markInherited(root, '');
    // An inherited scene takes its own root name; the base only supplies the nodes.
    if (parsed.root) {
      root.name = parsed.root.name;
      root.properties = { ...root.properties, ...parsed.root.properties };
    }

    const orphanNodes: string[] = [];
    for (const { key, node } of parsed.derived) {
      const existing = index.get(key);
      if (existing) {
        existing.properties = { ...existing.properties, ...node.properties };
        existing.origin = 'overridden';
        if (node.instance) {
          existing.instance = node.instance;
        }
        continue;
      }
      const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
      const parentNode = index.get(parentKey);
      if (!parentNode) {
        orphanNodes.push(node.name);
        continue;
      }
      node.origin = 'scene';
      node.children = [];
      parentNode.children.push(node);
      index.set(key, node);
    }

    const assignPaths = (node: SceneNodeInfo, key: string) => {
      node.path = key === '' ? root.name : `${root.name}/${key}`;
      for (const child of node.children) {
        assignPaths(child, key === '' ? child.name : `${key}/${child.name}`);
      }
    };
    assignPaths(root, '');

    return {
      format: parsed.format,
      root,
      nodeCount: index.size,
      extResources: parsed.extResources,
      subResources: parsed.subResources,
      orphanNodes,
      inheritsFrom: parsed.inheritsFrom,
    };
  }

  /**
   * Handle the read_scene tool: return the node tree of a .tscn scene file.
   */
  private async handleReadScene(args: any) {
    args = this.normalizeParameters(args);

    if (typeof args.projectPath !== 'string' || !args.projectPath || typeof args.scenePath !== 'string' || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide projectPath and scenePath (relative to the project)']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    const sceneFile = join(projectRoot, args.scenePath);
    if (!existsSync(sceneFile) || !statSync(sceneFile).isFile()) {
      return this.createErrorResponse(
        `Scene file not found: ${args.scenePath}`,
        ['Check the path relative to the project directory', 'Use create_scene to create a new scene']
      );
    }

    const parsed = this.readSceneTree(projectRoot, args.scenePath);
    if (!parsed.root) {
      return this.createErrorResponse(
        `No root node found in ${args.scenePath}`,
        ['The file may be empty or not a Godot scene']
      );
    }

    // A readable outline first, then the full structure for programmatic use.
    const outline: string[] = [];
    const walk = (node: SceneNodeInfo, depth: number) => {
      const tag = node.origin === 'inherited' ? ' [inherited]' : node.origin === 'overridden' ? ' [inherited, overridden]' : '';
      outline.push(`${'  '.repeat(depth)}- ${node.name} (${node.type ?? (node.instance ? 'instance' : 'unknown')}) ${node.path}${tag}`);
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    walk(parsed.root, 0);

    const summary = [
      `Scene ${args.scenePath}: ${parsed.nodeCount} nodes, ${parsed.extResources.length} external resources, ${parsed.subResources.length} sub-resources`,
      ...outline,
    ];
    if (parsed.inheritsFrom) {
      summary.splice(1, 0, `Inherits from ${parsed.inheritsFrom}; inherited nodes are shown with their origin`);
    }
    if (parsed.orphanNodes.length > 0) {
      summary.push('', `Nodes whose parent was not found: ${parsed.orphanNodes.join(', ')}`);
    }

    return {
      content: [
        { type: 'text', text: summary.join('\n') },
        {
          type: 'text',
          text: JSON.stringify(
            {
              format: parsed.format,
              root: parsed.root,
              extResources: parsed.extResources,
              subResources: parsed.subResources,
              orphanNodes: parsed.orphanNodes,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the set_node_property tool: change one property on a node and save the scene.
   */
  private async handleSetNodeProperty(args: any) {
    args = this.normalizeParameters(args);

    if (
      typeof args.projectPath !== 'string' || !args.projectPath ||
      typeof args.scenePath !== 'string' || !args.scenePath ||
      typeof args.nodePath !== 'string' || !args.nodePath ||
      typeof args.property !== 'string' || !args.property ||
      typeof args.value !== 'string'
    ) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, property, and value (value is a Godot literal, such as 42 or Vector2(1, 2))']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!/^[A-Za-z_][\w/]*$/.test(args.property)) {
      return this.createErrorResponse(
        `Invalid property name: ${args.property}`,
        ['Use a property name such as position, texture or metadata/key']
      );
    }

    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file']
      );
    }

    if (!existsSync(join(projectRoot, args.scenePath))) {
      return this.createErrorResponse(
        `Scene file not found: ${args.scenePath}`,
        ['Check the path relative to the project directory']
      );
    }

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      const { stdout, stderr } = await this.executeOperation(
        'set_node_property',
        {
          scenePath: args.scenePath,
          nodePath: args.nodePath,
          property: args.property,
          value: args.value,
        },
        args.projectPath
      );

      const failure = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => line.includes('Failed to'));
      if (failure) {
        return this.createErrorResponse(
          failure.trim(),
          [
            'Check the node path with read_scene (it starts with the root name, for example root/Player)',
            'Check that the value is a valid Godot literal, such as 42, true, "text" or Vector2(1, 2)',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Set ${args.property} on ${args.nodePath} in ${args.scenePath} and saved the scene.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to set property: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed and GODOT_PATH is set correctly']
      );
    }
  }

  /**
   * Run the read-only inspect_node operation. A failed check comes back as `failure`.
   */
  private async inspectNode(
    projectPath: string,
    params: Record<string, unknown>
  ): Promise<{ failure?: string; values: Record<string, string> }> {
    const { stdout, stderr } = await this.executeOperation('inspect_node', params as any, projectPath);
    const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
    const values: Record<string, string> = {};
    for (const line of lines) {
      const match = /^(VALUE|EXPECTED|HAS_VALUE|IS_SPRITE|TRANSFORM) (.*)$/.exec(line.trim());
      if (match) {
        values[match[1]] = match[2];
      }
    }
    const failure = lines.find((line) => line.includes('Failed to inspect'));
    if (failure) {
      return { failure: failure.trim(), values };
    }
    if (!lines.some((line) => line.includes('INSPECT_OK'))) {
      return { failure: 'Godot did not confirm the check', values };
    }
    return { values };
  }

  /**
   * Check the scene after a text edit. Any failed check restores the original text, so a
   * bad edit never stays in the file. Returns the problem, or undefined when all checks pass.
   */
  private async verifyOrRestore(
    projectPath: string,
    sceneFile: string,
    before: string,
    checks: { params: Record<string, unknown>; mode: 'exists' | 'equal' | 'hasValue' }[]
  ): Promise<string | undefined> {
    for (const check of checks) {
      const result = await this.inspectNode(projectPath, check.params);
      let problem = result.failure;
      if (!problem && check.mode === 'equal' && result.values.VALUE !== result.values.EXPECTED) {
        problem = `The property ${String(check.params.property)} did not match after the edit`;
      }
      if (!problem && check.mode === 'hasValue' && result.values.HAS_VALUE !== '1') {
        problem = `The property ${String(check.params.property)} was not set after the edit`;
      }
      if (problem) {
        writeFileSync(sceneFile, before);
        return `${problem}. The scene file was restored.`;
      }
    }
    return undefined;
  }

  /**
   * Route a tool call on a scene that inherits from another scene. Such scenes cannot be
   * re-packed without losing the inherited content, so their changes are written as text
   * (only the lines that change). Returns undefined for scenes that are not inherited.
   */
  private async handleInheritedScene(toolName: string, args: any): Promise<any | undefined> {
    if (typeof args?.projectPath !== 'string' || typeof args?.scenePath !== 'string') {
      return undefined;
    }
    const sceneFile = join(resolvePath(args.projectPath), args.scenePath);
    if (!this.isInheritedSceneFile(sceneFile)) {
      return undefined;
    }
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      switch (toolName) {
        case 'set_node_property':
          return await this.setPropertyInInheritedScene(args);
        case 'add_node':
          return await this.addNodeInInheritedScene(args);
        case 'load_sprite':
          return await this.loadSpriteInInheritedScene(args);
        case 'save_scene':
          return await this.saveInheritedScene(args);
        default:
          return undefined;
      }
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to edit the inherited scene: ${error?.message || 'Unknown error'}`,
        ['Ensure Godot is installed and GODOT_PATH is set correctly']
      );
    }
  }

  private async setPropertyInInheritedScene(args: any): Promise<any> {
    const projectRoot = resolvePath(args.projectPath);
    const sceneFile = join(projectRoot, args.scenePath);
    const before = readFileSync(sceneFile, 'utf8');
    const nodeKey = nodeKeyFromPath(String(args.nodePath), sceneRootName(before));
    if (nodeKey === null) {
      return this.createErrorResponse(
        `Node path must start with the root name: ${args.nodePath}`,
        ['Use read_scene to see the node paths']
      );
    }
    if (typeof args.value !== 'string' || args.value.includes('res://') || /[\r\n]/.test(args.value)) {
      return this.createErrorResponse(
        'On a scene that inherits from another scene, the value must be one plain Godot literal, without res:// resources',
        ['For textures, use load_sprite']
      );
    }

    // position, rotation and scale all live in the transform. When the section overrides the
    // transform, Godot computes the new transform from the change and that is written instead.
    const affectsTransform = TRANSFORM_PROPERTIES.includes(args.property);
    const usesTransform = affectsTransform && sceneSectionHasProperty(before, nodeKey, 'transform');
    const check = await this.inspectNode(args.projectPath, {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      property: args.property,
      value: args.value,
      ...(usesTransform ? { applyInMemory: true } : {}),
    });
    if (check.failure) {
      return this.createErrorResponse(check.failure, ['Check the node path and the property name with read_scene']);
    }

    let updated: string;
    if (usesTransform) {
      if (!check.values.TRANSFORM) {
        return this.createErrorResponse(
          `Godot did not return the transform for ${args.nodePath}`,
          ['Check that the node is a Node2D or Node3D']
        );
      }
      const withoutConflicts = removeSceneProperties(before, nodeKey, TRANSFORM_PROPERTIES);
      updated = setSceneProperty(withoutConflicts, nodeKey, 'transform', check.values.TRANSFORM);
    } else {
      updated = setSceneProperty(before, nodeKey, args.property, args.value);
    }
    writeFileSync(sceneFile, updated);

    const problem = await this.verifyOrRestore(args.projectPath, sceneFile, before, [
      {
        params: { scenePath: args.scenePath, nodePath: args.nodePath, property: args.property, value: args.value },
        mode: 'equal',
      },
    ]);
    if (problem) {
      return this.createErrorResponse(problem, ['Check the value is a valid Godot literal for this property']);
    }
    return {
      content: [
        {
          type: 'text',
          text: `Set ${args.property} on ${args.nodePath} in ${args.scenePath}. The scene inherits from another scene, so only that property line changed.`,
        },
      ],
    };
  }

  private async addNodeInInheritedScene(args: any): Promise<any> {
    const projectRoot = resolvePath(args.projectPath);
    const sceneFile = join(projectRoot, args.scenePath);
    const before = readFileSync(sceneFile, 'utf8');
    const rootName = sceneRootName(before);
    const parentPath = typeof args.parentNodePath === 'string' ? args.parentNodePath : rootName;
    const parentKey = nodeKeyFromPath(parentPath, rootName);
    if (parentKey === null) {
      return this.createErrorResponse(
        `Parent path must start with the root name: ${parentPath}`,
        ['Use read_scene to see the node paths']
      );
    }
    if (typeof args.nodeName !== 'string' || !/^[^"/\\]+$/.test(args.nodeName)) {
      return this.createErrorResponse(
        `Invalid node name: ${String(args.nodeName)}`,
        ['A node name cannot contain quotes, slashes or backslashes']
      );
    }
    if (typeof args.nodeType !== 'string' || !args.nodeType) {
      return this.createErrorResponse('Node type is required', ['Provide a built-in class such as Node3D']);
    }

    const parentAttribute = parentKey === '' ? '.' : parentKey;
    const newKey = sceneNodeKey(parentAttribute, args.nodeName);
    const properties: Record<string, unknown> = args.properties ?? {};
    const literals: { property: string; literal: string }[] = [];
    for (const [property, value] of Object.entries(properties)) {
      const literal = toGodotLiteral(value);
      if (literal === null || !/^[A-Za-z_][\w/]*$/.test(property)) {
        return this.createErrorResponse(
          `Property ${property} cannot be written on a scene that inherits from another scene`,
          ['Use a number, a boolean or a plain string here, or set the property with set_node_property']
        );
      }
      literals.push({ property, literal });
    }

    const check = await this.inspectNode(args.projectPath, {
      scenePath: args.scenePath,
      parentNodePath: parentPath,
      nodeName: args.nodeName,
      nodeType: args.nodeType,
    });
    if (check.failure) {
      return this.createErrorResponse(check.failure, ['Check the parent path, the name and the node type']);
    }

    let text = appendNodeSection(before, args.nodeName, args.nodeType, parentAttribute);
    for (const { property, literal } of literals) {
      text = setSceneProperty(text, newKey, property, literal);
    }
    writeFileSync(sceneFile, text);

    const nodePath = newKey === '' ? rootName : `${rootName}/${newKey}`;
    const checks: { params: Record<string, unknown>; mode: 'exists' | 'equal' | 'hasValue' }[] = [
      { params: { scenePath: args.scenePath, nodePath }, mode: 'exists' },
      ...literals.map(({ property, literal }) => ({
        params: { scenePath: args.scenePath, nodePath, property, value: literal },
        mode: 'equal' as const,
      })),
    ];
    const problem = await this.verifyOrRestore(args.projectPath, sceneFile, before, checks);
    if (problem) {
      return this.createErrorResponse(problem, ['Check the property values']);
    }
    return {
      content: [
        {
          type: 'text',
          text: `Node '${args.nodeName}' of type '${args.nodeType}' added under ${parentPath} in ${args.scenePath}. The scene inherits from another scene, so only the new node was written.`,
        },
      ],
    };
  }

  private async loadSpriteInInheritedScene(args: any): Promise<any> {
    const projectRoot = resolvePath(args.projectPath);
    const sceneFile = join(projectRoot, args.scenePath);
    const before = readFileSync(sceneFile, 'utf8');
    const nodeKey = nodeKeyFromPath(String(args.nodePath), sceneRootName(before));
    if (nodeKey === null) {
      return this.createErrorResponse(
        `Node path must start with the root name: ${args.nodePath}`,
        ['Use read_scene to see the node paths']
      );
    }
    if (!existsSync(join(projectRoot, args.texturePath))) {
      return this.createErrorResponse(
        `Texture not found: ${args.texturePath}`,
        ['Check the path relative to the project directory']
      );
    }

    const check = await this.inspectNode(args.projectPath, {
      scenePath: args.scenePath,
      nodePath: args.nodePath,
      checkSprite: true,
    });
    if (check.failure) {
      return this.createErrorResponse(check.failure, ['Check the node path with read_scene']);
    }
    if (check.values.IS_SPRITE !== '1') {
      return this.createErrorResponse(
        `Node is not a sprite-compatible type: ${args.nodePath}`,
        ['Use a Sprite2D, Sprite3D or TextureRect node']
      );
    }

    const added = addExternalResource(before, 'Texture2D', `res://${args.texturePath}`);
    writeFileSync(sceneFile, setSceneProperty(added.text, nodeKey, 'texture', `ExtResource("${added.id}")`));
    const problem = await this.verifyOrRestore(args.projectPath, sceneFile, before, [
      {
        params: { scenePath: args.scenePath, nodePath: args.nodePath, property: 'texture', checkHasValue: true },
        mode: 'hasValue',
      },
    ]);
    if (problem) {
      return this.createErrorResponse(problem, ['Check the texture file']);
    }
    return {
      content: [
        {
          type: 'text',
          text: `Sprite loaded successfully with texture: ${args.texturePath}. The scene inherits from another scene, so only the texture line changed.`,
        },
      ],
    };
  }

  private async saveInheritedScene(args: any): Promise<any> {
    const projectRoot = resolvePath(args.projectPath);
    const sceneFile = join(projectRoot, args.scenePath);
    if (typeof args.newPath !== 'string' || !args.newPath) {
      return {
        content: [
          {
            type: 'text',
            text: `Scene ${args.scenePath} inherits from another scene and has no pending changes to save.`,
          },
        ],
      };
    }
    const target = join(projectRoot, args.newPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(sceneFile));
    return {
      content: [{ type: 'text', text: `Scene saved successfully to: ${args.newPath}` }],
    };
  }

  /** Folder with the editor bridge plugin shipped in this server build. */
  private editorBridgeSource(): string {
    return join(__dirname, 'addons', 'godot_mcp_bridge');
  }

  /**
   * Add the bridge plugin to the enabled list in [editor_plugins] of project.godot.
   * Returns the text unchanged when the plugin is already listed.
   */
  private enableEditorPlugin(projectText: string, pluginCfg: string): string {
    const eol = projectText.includes('\r\n') ? '\r\n' : '\n';
    const quoted = `"${pluginCfg}"`;
    const lines = projectText.split(/\r?\n/);
    const section = lines.findIndex((line) => line.trim() === '[editor_plugins]');
    if (section === -1) {
      const trimmed = projectText.replace(/\s*$/, '');
      return `${trimmed}${eol}${eol}[editor_plugins]${eol}${eol}enabled=PackedStringArray(${quoted})${eol}`;
    }

    let end = lines.length;
    for (let i = section + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) {
        end = i;
        break;
      }
    }
    let enabled = -1;
    for (let i = section + 1; i < end; i++) {
      if (lines[i].startsWith('enabled=')) {
        enabled = i;
        break;
      }
    }
    if (enabled === -1) {
      lines.splice(section + 1, 0, `enabled=PackedStringArray(${quoted})`);
      return lines.join(eol);
    }

    const match = /^enabled=PackedStringArray\((.*)\)\s*$/.exec(lines[enabled]);
    if (!match) {
      throw new Error('project.godot has an enabled= line this tool does not understand. Enable the plugin in the editor instead.');
    }
    if (match[1].includes(pluginCfg)) {
      return projectText;
    }
    const items = match[1].trim();
    lines[enabled] = `enabled=PackedStringArray(${items === '' ? quoted : `${items}, ${quoted}`})`;
    return lines.join(eol);
  }

  /** Connection details the editor writes to .godot/mcp_bridge.json while the plugin runs. */
  private readEditorBridgeInfo(projectRoot: string): { port: number; token: string } | undefined {
    const infoPath = join(projectRoot, '.godot', 'mcp_bridge.json');
    if (!existsSync(infoPath)) {
      return undefined;
    }
    try {
      const info = JSON.parse(readFileSync(infoPath, 'utf8'));
      if (typeof info.port === 'number' && typeof info.token === 'string') {
        return { port: info.port, token: info.token };
      }
    } catch {
      // A damaged file is treated as no bridge.
    }
    return undefined;
  }

  /** Send one request to the editor bridge and wait for its one-line answer. */
  private sendEditorRequest(
    info: { port: number; token: string },
    command: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: any; error?: string; code?: ToolErrorCode }> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: info.port });
      let data = '';
      let settled = false;
      const finish = (value: { ok: boolean; result?: any; error?: string; code?: ToolErrorCode }) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(value);
        }
      };
      socket.setTimeout(15000, () => finish({ ok: false, error: 'The editor did not answer within 15 seconds', code: 'EDITOR_TIMEOUT' }));
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id: 1, token: info.token, command, arguments: args }) + '\n');
      });
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline !== -1) {
          try {
            finish(JSON.parse(data.slice(0, newline)));
          } catch {
            finish({ ok: false, error: 'The editor bridge sent an answer that is not valid JSON', code: 'EDITOR_REFUSED' });
          }
        }
      });
      socket.on('error', (error: Error) => finish({ ok: false, error: `Could not reach the editor bridge: ${error.message}`, code: 'EDITOR_NOT_CONNECTED' }));
      socket.on('close', () => finish({ ok: false, error: 'The editor closed the connection without answering', code: 'EDITOR_NOT_CONNECTED' }));
    });
  }

  /**
   * Handle the install_editor_bridge tool: copy the bridge plugin into the project and enable it.
   */
  private async handleInstallEditorBridge(args: any) {
    if (typeof args?.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory']);
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." or other potentially unsafe characters']);
    }

    const projectRoot = resolvePath(args.projectPath);
    const projectFile = join(projectRoot, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        ['Ensure the path points to a directory containing a project.godot file']
      );
    }
    const source = this.editorBridgeSource();
    if (!existsSync(join(source, 'plugin.cfg'))) {
      return this.createErrorResponse('The editor bridge files are missing from this server build', ['Rebuild the server (npm run build)']);
    }

    try {
      // Compute the project change first, so a file this tool cannot edit leaves no partial install.
      const original = readFileSync(projectFile, 'utf8');
      const updated = this.enableEditorPlugin(original, 'res://addons/godot_mcp_bridge/plugin.cfg');
      cpSync(source, join(projectRoot, 'addons', 'godot_mcp_bridge'), { recursive: true });
      if (updated !== original) {
        writeFileSync(projectFile, updated);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Installed the Godot MCP Bridge in ${args.projectPath} and enabled it in project.godot. Open the project in the Godot editor (or reload it) so the plugin starts, then editor_status should report it connected.`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Could not install the bridge: ${error?.message || 'Unknown error'}`,
        ['Check that the project folder is writable']
      );
    }
  }

  /**
   * Handle the editor_status tool: is the project open in the editor with the bridge enabled?
   */
  private async handleEditorStatus(args: any) {
    if (typeof args?.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." or other potentially unsafe characters'], { code: 'INVALID_PATH' });
    }

    const info = this.readEditorBridgeInfo(resolvePath(args.projectPath));
    if (!info) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              connected: false,
              reason: 'No bridge information in .godot/mcp_bridge.json. Install the bridge with install_editor_bridge and open the project in the Godot editor.',
            }, null, 2),
          },
        ],
      };
    }

    const response = await this.sendEditorRequest(info, 'status', {});
    if (!response.ok) {
      return this.createErrorResponse(
        `Not connected: ${response.error ?? 'unknown error'}`,
        ['The editor may have closed; its bridge file can be left over from an earlier session', 'Open the project in the Godot editor'],
        { code: response.code ?? 'EDITOR_NOT_CONNECTED' }
      );
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ connected: true, ...response.result }, null, 2) }],
    };
  }

  /**
   * Handle the editor_command tool: run one allowed command in the open editor.
   */
  private async handleEditorCommand(args: any) {
    if (typeof args?.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." or other potentially unsafe characters'], { code: 'INVALID_PATH' });
    }
    if (typeof args.command !== 'string' || !EDITOR_BRIDGE_COMMANDS.includes(args.command)) {
      return this.createErrorResponse(
        `Unknown editor command: ${String(args.command)}`,
        [`Use one of: ${EDITOR_BRIDGE_COMMANDS.join(', ')}`],
        { code: 'INVALID_ARGUMENT' }
      );
    }
    const commandArgs: unknown = args.arguments ?? {};
    if (typeof commandArgs !== 'object' || commandArgs === null || Array.isArray(commandArgs)) {
      return this.createErrorResponse('arguments must be an object', ['Pass the command arguments as an object'], { code: 'INVALID_ARGUMENT' });
    }

    const info = this.readEditorBridgeInfo(resolvePath(args.projectPath));
    if (!info) {
      return this.createErrorResponse(
        'The Godot editor bridge is not running for this project',
        ['Install it with install_editor_bridge and open the project in the Godot editor'],
        { code: 'EDITOR_NOT_CONNECTED' }
      );
    }

    const response = await this.sendEditorRequest(info, args.command, commandArgs as Record<string, unknown>);
    if (!response.ok) {
      return this.createErrorResponse(
        response.error ?? 'The editor refused the command',
        ['Check the arguments with editor_status'],
        { code: response.code ?? 'EDITOR_REFUSED' }
      );
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(response.result ?? {}, null, 2) }],
    };
  }

  /**
   * Handle the verify_game tool: play a scene with the editor bridge's probe, check that the frame
   * counter keeps advancing, take a screenshot, collect the runtime errors and stop the game.
   */
  private async handleVerifyGame(args: any) {
    if (typeof args?.projectPath !== 'string' || !args.projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." or other potentially unsafe characters'], { code: 'INVALID_PATH' });
    }
    if (args.scene !== undefined && (typeof args.scene !== 'string' || args.scene === '')) {
      return this.createErrorResponse('scene must be a res:// path to a .tscn file', ['Omit scene to run the scene open in the editor'], { code: 'INVALID_ARGUMENT' });
    }
    const durationMs: number = typeof args.durationMs === 'number' ? Math.min(Math.max(args.durationMs, 500), 60000) : 3000;
    const capture: boolean = args.capture !== false;

    const info = this.readEditorBridgeInfo(resolvePath(args.projectPath));
    if (!info) {
      return this.createErrorResponse(
        'The Godot editor bridge is not running for this project',
        ['Install it with install_editor_bridge and open the project in the Godot editor'],
        { code: 'EDITOR_NOT_CONNECTED' }
      );
    }

    const play = await this.sendEditorRequest(info, 'play', args.scene ? { mode: 'probe', scene: args.scene } : { mode: 'probe' });
    if (!play.ok) {
      return this.createErrorResponse(
        `Could not start the game: ${play.error ?? 'unknown error'}`,
        ['Save the scene open in the editor, or pass scene'],
        { code: play.code ?? 'EDITOR_REFUSED' }
      );
    }
    // Only this run's status and screenshots count; a game left running from an earlier run has another session.
    const session = String(play.result?.session ?? '');
    if (session === '') {
      await this.sendEditorRequest(info, 'stop', {});
      return this.createErrorResponse('The editor bridge did not return a probe session', ['Run install_editor_bridge again so the project has the current bridge']);
    }

    try {
      // The probe writes its status when the game starts and at every error; attached is true once the scene is added.
      const started = await this.waitForProbeStatus(info, session, (s) => s.attached === true || s.load_error !== '' || s.error_count > 0, 15000);
      if (!started) {
        return this.createErrorResponse(
          'The game did not add its scene within 15 seconds',
          ['It may be frozen while loading, for example in a _ready that never returns'],
          { code: 'PROBE_NOT_READY' }
        );
      }
      if (started.attached !== true) {
        // Godot pauses the game at a script error, so the scene never gets added. Report the errors that stopped it.
        const stopped = (started.errors ?? []).filter((e: any) => e.kind !== 'warning');
        const reason = started.load_error || (stopped[0]?.message ?? 'unknown error');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              scene: started.target,
              advancing: false,
              reason: `The game stopped before its scene was added: ${reason}`,
              errorCount: stopped.length,
              errors: stopped.slice(0, 50),
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Sample the frame counter during the window. The game counts as advancing only if the counter
      // still grows in the last second, so a game that freezes in the middle of the window is reported.
      const samples: { frames: number; at: number }[] = [];
      const windowEnd = Date.now() + durationMs;
      while (Date.now() < windowEnd) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const now = await this.readProbeStatus(info, session);
        if (now) {
          samples.push({ frames: now.frames as number, at: Date.now() });
        }
      }
      const later = (await this.readProbeStatus(info, session)) ?? started;
      const latest = { frames: later.frames as number, at: Date.now() };
      const tailStart = latest.at - Math.min(1000, durationMs);
      const earlier: { frames: number } = [...samples].reverse().find((s) => s.at <= tailStart) ?? samples[0] ?? { frames: started.frames as number };
      const frames = { first: started.frames as number, second: latest.frames };
      const advancing = latest.frames > earlier.frames;

      let screenshot: { path: string; data: string } | undefined;
      let captureError: string | undefined;
      if (capture) {
        const id = `verify-${Date.now()}`;
        const requested = await this.sendEditorRequest(info, 'probe_capture', { id, session });
        if (!requested.ok) {
          captureError = requested.error;
        } else {
          const shot = await this.waitForProbeStatus(info, session, (s) => s.capture_id === id && (s.capture_path !== '' || s.capture_error !== ''), 5000);
          if (!shot) {
            captureError = 'The probe did not answer the screenshot request within 5 seconds';
          } else if (shot.capture_path !== '') {
            screenshot = { path: shot.capture_path, data: readFileSync(shot.capture_path).toString('base64') };
          } else {
            captureError = shot.capture_error;
          }
        }
      }

      const entries: any[] = later.errors ?? [];
      const errors = entries.filter((e) => e.kind !== 'warning');
      const warningCount = entries.length - errors.length;
      const report = {
        scene: started.target,
        advancing,
        frames,
        durationMs,
        errorCount: errors.length,
        errors: errors.slice(0, 50),
        warningCount,
        screenshot: screenshot?.path,
        captureError,
      };
      const content: any[] = [{ type: 'text', text: JSON.stringify(report, null, 2) }];
      if (screenshot) {
        content.push({ type: 'image', data: screenshot.data, mimeType: 'image/png' });
      }
      return { content, isError: !advancing || errors.length > 0 };
    } finally {
      await this.sendEditorRequest(info, 'stop', {});
    }
  }

  /** Read the probe's status for one run, or undefined when this run has not reported yet. */
  private async readProbeStatus(info: { port: number; token: string }, session: string): Promise<any | undefined> {
    const response = await this.sendEditorRequest(info, 'probe_status', {});
    const status = response.ok ? response.result?.status : undefined;
    return status?.session === session ? status : undefined;
  }

  /** Poll the probe until the predicate holds, or return undefined when the timeout passes. */
  private async waitForProbeStatus(
    info: { port: number; token: string },
    session: string,
    ready: (status: any) => boolean,
    timeoutMs: number
  ): Promise<any | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.readProbeStatus(info, session);
      if (status && ready(status)) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const fs = require('fs');
        const projectFileContent = fs.readFileSync(projectFile, 'utf8');
        const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse(
        'Invalid rootNodeType',
        ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to create scene: ${stderr}`,
          [
            'Check if the root node type is valid',
            'Ensure you have write permissions to the scene path',
            'Verify the scene path is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse(
        'Invalid nodeType',
        ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to add node: ${stderr}`,
          [
            'Check if the node type is valid',
            'Ensure the parent node path exists',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to load sprite: ${stderr}`,
          [
            'Check if the node path is correct',
            'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
            'Verify the texture file is a valid image format',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to export mesh library: ${stderr}`,
          [
            'Check if the scene contains valid 3D meshes',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      // Godot can fail (for example, when the scene has no meshes) without writing
      // "Failed to" to stderr, and executeOperation does not expose the exit code.
      // Confirm the file exists before reporting success.
      const outputFile = join(args.projectPath, String(args.outputPath).replace(/^res:\/\//, ''));
      if (!existsSync(outputFile)) {
        return this.createErrorResponse(
          `Failed to export mesh library: no file was created at ${args.outputPath}`,
          [
            'Check that the scene contains at least one MeshInstance3D with a mesh assigned',
            'Ensure the output path is valid',
            'Verify the scene file is valid',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to save scene: ${stderr}`,
          [
            'Check if the scene file is valid',
            'Ensure you have write permissions to the output path',
            'Verify the scene can be properly packed',
          ]
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to get UID: ${stderr}`,
          [
            'Check if the file is a valid Godot resource',
            'Ensure the file path is correct',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return this.createErrorResponse(
          `Failed to update project UIDs: ${stderr}`,
          [
            'Check if the project is valid',
            'Ensure you have write permissions to the project directory',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      try {
        await this.detectGodotPath();
      } catch (error: unknown) {
        // Only strict mode stops the server. Otherwise it keeps serving: tools that do not
        // need Godot still work, and tools that do return this same message as their error.
        if (this.strictPathValidation) {
          throw error;
        }
        console.error(`[SERVER] ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      const isValid = this.godotPath ? await this.isValidGodotPath(this.godotPath) : false;

      if (!this.godotPath) {
        console.error('[SERVER] No Godot executable is configured. Tools that run Godot will fail until GODOT_PATH is fixed.');
      } else if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      if (this.godotPath) {
        console.error(`[SERVER] Using Godot at: ${this.godotPath}`);
      }

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
