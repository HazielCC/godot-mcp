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
import { copyFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, cpSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import {
  createCheckpoint, deleteCheckpoint, diffCheckpoint, explainError, findCheckpoint, listCheckpoints, moveResource,
  repairProject, restoreCheckpoint, validateProject,
} from './recovery.js';
import { buildGutTest, globToRegExp, parseScript } from './testing.js';

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
// The verbose mode of godot_operations.gd writes test files into the project, waits 500 ms per scene
// and prints environment variables, so it is opt-in: set GODOT_MCP_DEBUG=true.
const GODOT_DEBUG_MODE: boolean = process.env.GODOT_MCP_DEBUG === 'true';

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Version from package.json, so the server does not report a number that has drifted. */
function readPackageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
  | 'BASELINE_MISSING'
  | 'OPERATION_FAILED';

/** Codes where repeating the same call later may succeed without changing its arguments. */
const RETRYABLE_ERROR_CODES: ToolErrorCode[] =['TIMEOUT', 'EDITOR_TIMEOUT', 'PROBE_NOT_READY'];

/** One test result, as read from GUT's JUnit XML. */
type TestRecord = { suite: string; name: string; status: string; time: number; message?: string };

/** The last full run_tests result of a project, kept in .godot/mcp_tests_last.json for rerunFailed. */
type TestState = { directory: string; savedAt: string; tests: TestRecord[] };

/**
 * Operations that load a scene, change it and save it again with Godot. Godot's headless mode has no
 * rendering server, and a MultiMesh keeps its instance data there, so such a save erases it. The data
 * is read from the file before the operation and written back after it (see preserveMultiMeshData).
 */
const REPACKING_OPERATIONS = [
  'add_node', 'load_sprite', 'set_node_property', 'save_scene', 'import_spritesheet', 'auto_collision',
  'build_tilemap', 'setup_parallax_2d', 'build_blockout', 'create_pbr_material', 'bake_navmesh', 'build_ui', 'make_theme', 'create_particles', 'tune_particles',
];

/** The buffer line of each MultiMesh in a scene text, by the key of the node that uses it. */
function readMultiMeshBuffers(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const bufferById = new Map<string, string>();
  let subId: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[sub_resource\s(.*)\]$/.exec(line);
    if (header) {
      const attributes = parseSceneAttributes(header[1]);
      subId = attributes.type === 'MultiMesh' ? attributes.id : undefined;
    } else if (line.startsWith('[')) {
      subId = undefined;
    } else if (subId !== undefined && line.startsWith('buffer = ')) {
      bufferById.set(subId, raw);
    }
  }
  const byNode = new Map<string, string>();
  lines.forEach((raw, index) => {
    const header = /^\[node\s(.*)\]$/.exec(raw.trim());
    if (!header) {
      return;
    }
    const attributes = parseSceneAttributes(header[1]);
    for (let i = index + 1; i < lines.length && !lines[i].trim().startsWith('['); i++) {
      const use = /^multimesh = SubResource\("([^"]+)"\)/.exec(lines[i].trim());
      if (use && bufferById.has(use[1])) {
        byNode.set(sceneNodeKey(attributes.parent, attributes.name ?? ''), bufferById.get(use[1])!);
      }
    }
  });
  return byNode;
}

/** Put the buffer lines back into the MultiMesh sub-resources that the nodes use. Returns the new text. */
function writeMultiMeshBuffers(text: string, buffers: Map<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const [key, bufferLine] of buffers) {
    const section = locateNodeSection(lines, key);
    if (!section) {
      continue;
    }
    let id: string | undefined;
    for (let i = section.headerIndex + 1; i < section.end; i++) {
      id = /^multimesh = SubResource\("([^"]+)"\)/.exec(lines[i].trim())?.[1] ?? id;
    }
    const start = lines.findIndex((line) => {
      const header = /^\[sub_resource\s(.*)\]$/.exec(line.trim());
      return header !== null && parseSceneAttributes(header[1]).id === id;
    });
    if (id === undefined || start === -1) {
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !lines[end].trim().startsWith('[')) {
      end++;
    }
    const kept = lines.slice(start + 1, end).filter((line) => !line.trim().startsWith('buffer = '));
    // A blank line before the next section stays after the buffer.
    let tail = 0;
    while (kept.length - tail > 0 && kept[kept.length - tail - 1].trim() === '') {
      tail++;
    }
    kept.splice(kept.length - tail, 0, bufferLine);
    lines.splice(start + 1, end - start - 1, ...kept);
  }
  return lines.join(eol);
}

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
  import_spritesheet: ['texturePath', 'outputPath', 'scenePath'],
  auto_collision: ['scenePath'],
  build_tilemap: ['scenePath', 'texturePath', 'tileSetPath'],
  setup_parallax_2d: ['scenePath'],
  render_scene_2d: ['scenePath'],
  build_blockout: ['scenePath'],
  create_pbr_material: ['folder', 'outputPath', 'scenePath'],
  scatter_multimesh: ['scenePath', 'meshPath'],
  bake_navmesh: ['scenePath'],
  render_scene_3d: ['scenePath'],
  build_ui: ['scenePath'],
  make_theme: ['outputPath', 'scenePath', 'fontPath'],
  render_scene_ui: ['scenePath'],
  ui_lint: ['scenePath'],
  ui_check_focus: ['scenePath'],
  ui_check_contrast: ['scenePath'],
  create_particles: ['scenePath', 'texturePath'],
  tune_particles: ['scenePath', 'texturePath'],
  render_particles: ['scenePath'],
  move_resource: ['from', 'to'],
  play_scenario: ['scenePath'],
  visual_regression: ['scenePath'],
  perf_budget: ['scenePath'],
  generate_tests: ['scriptPath', 'testDir'],
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
  // The last line of a stream that has not ended yet; a chunk can stop in the middle of a line.
  partialLine: { output: string; errors: string };
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
  private renderScenePath: string;
  private renderScene3dPath: string;
  private renderSceneUiPath: string;
  private inspectUiPath: string;
  private renderParticlesPath: string;
  private smokeScenesPath: string;
  private playScenarioPath: string;
  private profileScenePath: string;
  private imageDiffPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  private godotDebugMode: boolean = GODOT_DEBUG_MODE;

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

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        this.godotDebugMode = config.godotDebugMode;
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
    this.renderScenePath = join(__dirname, 'scripts', 'render_scene.gd');
    this.renderScene3dPath = join(__dirname, 'scripts', 'render_scene_3d.gd');
    this.renderSceneUiPath = join(__dirname, 'scripts', 'render_scene_ui.gd');
    this.inspectUiPath = join(__dirname, 'scripts', 'inspect_ui.gd');
    this.renderParticlesPath = join(__dirname, 'scripts', 'render_particles.gd');
    this.smokeScenesPath = join(__dirname, 'scripts', 'smoke_scenes.gd');
    this.playScenarioPath = join(__dirname, 'scripts', 'play_scenario.gd');
    this.profileScenePath = join(__dirname, 'scripts', 'profile_scene.gd');
    this.imageDiffPath = join(__dirname, 'scripts', 'image_diff.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: readPackageVersion(),
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
    // Stop the running game and close when the client ends the session in any way. Without this,
    // a Godot process started by run_project would be left running after the client closes.
    const shutdown = async () => {
      await this.cleanup();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('end', shutdown);
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
    // Only a ".." path segment climbs out of a folder; a name such as "a..b" is fine.
    if (!path || path.split(/[\\/]/).includes('..')) {
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

    const multiMeshFiles = this.snapshotMultiMeshData(operation, params, projectPath);
    try {
      return await this.runOperation(operation, params, projectPath);
    } finally {
      this.restoreMultiMeshData(multiMeshFiles);
    }
  }

  /**
   * The MultiMesh data of the scene files that an operation is going to re-save. Godot in headless mode
   * drops that data when it saves a scene, so it is put back afterwards by restoreMultiMeshData.
   */
  private snapshotMultiMeshData(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): { file: string; copyTo?: string; buffers: Map<string, string> }[] {
    const projectRoot = resolvePath(projectPath);
    let files: string[] = [];
    if (operation === 'resave_resources') {
      files = this.listProjectFiles(projectRoot, projectRoot, ['tscn']).map((file) => join(projectRoot, file));
    } else if (REPACKING_OPERATIONS.includes(operation) && typeof params.scenePath === 'string') {
      files = [join(projectRoot, params.scenePath)];
    }
    const found: { file: string; copyTo?: string; buffers: Map<string, string> }[] = [];
    for (const file of files) {
      if (!existsSync(file)) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      if (!text.includes('type="MultiMesh"')) {
        continue;
      }
      const buffers = readMultiMeshBuffers(text);
      if (buffers.size > 0) {
        const copyTo = operation === 'save_scene' && typeof params.newPath === 'string' ? join(projectRoot, params.newPath) : undefined;
        found.push({ file, copyTo, buffers });
      }
    }
    return found;
  }

  private restoreMultiMeshData(snapshots: { file: string; copyTo?: string; buffers: Map<string, string> }[]): void {
    for (const { file, copyTo, buffers } of snapshots) {
      for (const target of [file, copyTo]) {
        if (target === undefined || !existsSync(target)) {
          continue;
        }
        const text = readFileSync(target, 'utf8');
        const restored = writeMultiMeshBuffers(text, buffers);
        if (restored !== text) {
          writeFileSync(target, restored);
        }
      }
    }
  }

  /** Run one operation of godot_operations.gd (see executeOperation, which also protects MultiMesh data). */
  private async runOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
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

      
      if (this.godotDebugMode) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(this.godotPath!, args, {
        timeout: 120000,
        maxBuffer: 64 * 1024 * 1024,
      });

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: any) {
      // A timeout, or an executable that could not be started (ENOENT, EACCES), has no
      // operation result to report. Returning the empty output would look like a success.
      if (error?.killed) {
        throw new Error(`Godot did not finish the operation '${operation}' within 120 seconds`);
      }
      if (typeof error?.code !== 'number' && !error?.signal) {
        throw error;
      }

      // Godot ran and exited with an error. The handlers look for "Failed to" in stderr,
      // so make sure a failure without that wording is still reported as one.
      const stdout: string = error?.stdout ?? '';
      let stderr: string = error?.stderr ?? '';
      if (!stderr.includes('Failed to')) {
        const how = error?.signal ? `signal ${error.signal}` : `exit code ${error.code}`;
        stderr = `${stderr}\nFailed to run the operation '${operation}' (Godot stopped with ${how}).`.trim();
      }
      return { stdout, stderr };
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
        {
          name: 'import_spritesheet',
          description: 'Cut a sprite sheet into frames and save a SpriteFrames resource (.tres) with named animations. Optionally add an AnimatedSprite2D that uses it to a scene. Use frameWidth and frameHeight, or columns and rows.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              texturePath: { type: 'string', description: 'Sprite sheet image, relative to the project' },
              outputPath: { type: 'string', description: 'Where to save the SpriteFrames, relative to the project, ending in .tres' },
              frameWidth: { type: 'number', description: 'Width of one frame in pixels' },
              frameHeight: { type: 'number', description: 'Height of one frame in pixels' },
              columns: { type: 'number', description: 'Number of columns, as an alternative to frameWidth/frameHeight' },
              rows: { type: 'number', description: 'Number of rows, as an alternative to frameWidth/frameHeight' },
              animations: {
                type: 'array',
                description: 'Animations to create. Each has name, and either row (a whole row of the sheet) or start and count (frame numbers, row by row), plus optional fps (default 10) and loop (default true). Default: one animation "default" with every frame.',
                items: { type: 'object' },
              },
              scenePath: { type: 'string', description: 'Optional scene to add an AnimatedSprite2D to (it must not inherit from another scene)' },
              parentNodePath: { type: 'string', description: 'Parent for the AnimatedSprite2D, such as "Main" or "Main/Player". Default: the scene root' },
              nodeName: { type: 'string', description: 'Name of the AnimatedSprite2D. Default: AnimatedSprite2D' },
            },
            required: ['projectPath', 'texturePath', 'outputPath'],
          },
        },
        {
          name: 'auto_collision',
          description: 'Build collision polygons (CollisionPolygon2D) or light occluders (LightOccluder2D) from the opaque pixels of a Sprite2D, and add them to the scene. The sprite should be a child of a StaticBody2D, Area2D or similar for collisions.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project (it must not inherit from another scene)' },
              nodePath: { type: 'string', description: 'Path of the Sprite2D, starting with the root name, for example "Player/Sprite2D"' },
              kind: { type: 'string', enum: ['collision', 'occluder'], description: 'collision (default) or occluder' },
              epsilon: { type: 'number', description: 'Simplification of the outline in pixels; higher gives fewer points. Default 2' },
              minArea: { type: 'number', description: 'Ignore shapes smaller than this many square pixels. Default 16' },
              alphaThreshold: { type: 'number', description: 'Alpha above this counts as solid, 0 to 1. Default 0.1' },
              targetPath: { type: 'string', description: 'Node that receives the polygons: the sprite itself or its parent (default)' },
              replace: { type: 'boolean', description: 'Replace polygons made by an earlier call instead of failing. Default false' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'build_tilemap',
          description: 'Paint a TileMapLayer from rows of text and add it to a scene. Each character is looked up in the legend to find its cell in the tile atlas; "." and spaces stay empty. Creates the TileSet from a texture when it does not exist. Needs Godot 4.3 or later.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              rows: { type: 'array', items: { type: 'string' }, description: 'One string per map row, for example ["####", "#..#", "####"]' },
              legend: { type: 'object', description: 'Atlas cell of each character, for example {"#": {"x": 0, "y": 0}, "~": [1, 0]}' },
              texturePath: { type: 'string', description: 'Tile atlas image, used to create the TileSet' },
              tileSetPath: { type: 'string', description: 'TileSet (.tres) to use, or to create and save when it does not exist' },
              tileSize: { type: 'number', description: 'Tile size in pixels, for a new TileSet. Default 16' },
              parentNodePath: { type: 'string', description: 'Parent of the layer. Default: the scene root' },
              nodeName: { type: 'string', description: 'Name of the layer. Default: TileMapLayer' },
              originX: { type: 'number', description: 'Cell column of the first character. Default 0' },
              originY: { type: 'number', description: 'Cell row of the first row. Default 0' },
            },
            required: ['projectPath', 'scenePath', 'rows', 'legend'],
          },
        },
        {
          name: 'setup_parallax_2d',
          description: 'Add parallax background layers (Parallax2D nodes, each with a Sprite2D) to a scene. Needs Godot 4.3 or later.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              layers: {
                type: 'array',
                description: 'Layers, back to front. Each has name, texturePath, and optional scrollScale (a number, or {x, y}; default 1), repeat (tile the texture horizontally), repeatTimes (default 3) and zIndex.',
                items: { type: 'object' },
              },
              parentNodePath: { type: 'string', description: 'Parent of the layers. Default: the scene root' },
            },
            required: ['projectPath', 'scenePath', 'layers'],
          },
        },
        {
          name: 'render_scene_2d',
          description: 'Draw a scene and return it as a PNG image, to check how it looks. It opens a short-lived Godot window, so it needs a display and a graphics driver (it does not work with --headless or on a server without a display).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              width: { type: 'number', description: 'Image width in pixels, 64 to 4096. Default 1280' },
              height: { type: 'number', description: 'Image height in pixels, 64 to 4096. Default 720' },
              zoom: { type: 'number', description: 'Zoom of the view, for scenes without a Camera2D. Default 1' },
              centerX: { type: 'number', description: 'World X at the center of the image (needs centerY)' },
              centerY: { type: 'number', description: 'World Y at the center of the image (needs centerX)' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'build_blockout',
          description: 'Build a greybox 3D level from rows of text and add it to a scene. Each character of the legend has a height, elevation, color and collision flag; runs of equal characters in a row become one box (a StaticBody3D with a MeshInstance3D and a BoxShape3D, or only a MeshInstance3D without collision). "." and spaces stay empty.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project (it must not inherit from another scene)' },
              rows: { type: 'array', items: { type: 'string' }, description: 'One string per row of the map; rows go along +Z and columns along +X, for example ["#####", "#...#", "#####"]' },
              legend: { type: 'object', description: 'Style of each character, for example {"#": {"height": 3, "color": "#8a8a8a"}, "~": {"height": 0.2, "color": "#3a6ea5", "collision": false}}. Optional per character: elevation (base height, default 0)' },
              cellSize: { type: 'number', description: 'Size of one cell in meters. Default 2' },
              parentNodePath: { type: 'string', description: 'Parent of the container, such as "Level". Default: the scene root' },
              nodeName: { type: 'string', description: 'Name of the container Node3D. Default: Blockout' },
              originX: { type: 'number', description: 'Cell column of the first character. Default 0' },
              originZ: { type: 'number', description: 'Cell row of the first row. Default 0' },
            },
            required: ['projectPath', 'scenePath', 'rows', 'legend'],
          },
        },
        {
          name: 'create_pbr_material',
          description: 'Create a StandardMaterial3D (.tres) from a folder of textures, matching files by name: albedo/basecolor/diffuse, normal, roughness, metallic, ao, orm (packed), emission, height. Optionally assign it to a node of a scene. The textures must be imported.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              folder: { type: 'string', description: 'Folder with the texture files, relative to the project' },
              outputPath: { type: 'string', description: 'Where to save the material, relative to the project, ending in .tres' },
              uvScale: { type: 'number', description: 'Texture repeat. Default 1' },
              triplanar: { type: 'boolean', description: 'Use triplanar mapping. Default false' },
              scenePath: { type: 'string', description: 'Optional scene with a node that gets this material as its material override' },
              nodePath: { type: 'string', description: 'With scenePath: the MeshInstance3D (or other GeometryInstance3D), starting with the root name' },
            },
            required: ['projectPath', 'folder', 'outputPath'],
          },
        },
        {
          name: 'scatter_multimesh',
          description: 'Add a MultiMeshInstance3D with many copies of a mesh spread at random over a rectangle (trees, rocks, grass). The result is repeatable: the same seed gives the same layout. The mesh is a Mesh resource, a model, or a simple primitive. Because Godot cannot store a MultiMesh in headless mode, this tool writes the scene file itself, and the other tools put the data back when they re-save a scene.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              meshPath: { type: 'string', description: 'Mesh to copy: a Mesh resource (.tres, .res, .obj), or a model or scene (.glb, .gltf, .fbx, .tscn) whose first MeshInstance3D is saved as a .res next to it. Without it, primitive is used' },
              meshNode: { type: 'string', description: 'With a model or scene: name of the MeshInstance3D to copy. Default: the first one' },
              meshOutputPath: { type: 'string', description: 'With a model or scene: where to save the extracted mesh (.res or .tres). Default: next to the model, ending in _mesh.res' },
              primitive: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone'], description: 'Shape when there is no meshPath. Default box' },
              primitiveSize: { type: 'number', description: 'Size of the primitive in meters. Default 1' },
              color: { type: 'string', description: 'Color of the primitive, such as "#4f8a3c"' },
              count: { type: 'number', description: 'Number of copies, 1 to 5000. Default 100' },
              centerX: { type: 'number', description: 'Center of the area on X. Default 0' },
              centerZ: { type: 'number', description: 'Center of the area on Z. Default 0' },
              y: { type: 'number', description: 'Height of the copies. Default 0' },
              sizeX: { type: 'number', description: 'Width of the area on X. Default 20' },
              sizeZ: { type: 'number', description: 'Depth of the area on Z. Default 20' },
              minScale: { type: 'number', description: 'Smallest scale. Default 1' },
              maxScale: { type: 'number', description: 'Largest scale. Default 1' },
              randomYaw: { type: 'boolean', description: 'Turn each copy at random around the vertical axis. Default true' },
              tiltDegrees: { type: 'number', description: 'Largest random tilt in degrees. Default 0' },
              seed: { type: 'number', description: 'Random seed. Default 1' },
              parentNodePath: { type: 'string', description: 'Parent of the node. Default: the scene root' },
              nodeName: { type: 'string', description: 'Name of the node. Default: Scatter' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'bake_navmesh',
          description: 'Bake a navigation mesh from the geometry of a 3D scene (mesh instances and/or static colliders) and add it in a NavigationRegion3D. Geometry is read from a copy of the scene with its scripts removed (unless runScripts is true).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project (it must not inherit from another scene)' },
              geometryPath: { type: 'string', description: 'Node whose children are read, starting with the root name. Default: the scene root' },
              parsedGeometry: { type: 'string', enum: ['meshes', 'colliders', 'both'], description: 'What to read. Default both' },
              agentRadius: { type: 'number', description: 'Radius of the walking agent in meters. Default 0.5' },
              agentHeight: { type: 'number', description: 'Height of the agent. Default 1.8' },
              agentMaxClimb: { type: 'number', description: 'Highest step the agent climbs. Default 0.25' },
              agentMaxSlope: { type: 'number', description: 'Steepest slope in degrees. Default 45' },
              cellSize: { type: 'number', description: 'Voxel size on the ground plane. Default 0.25' },
              cellHeight: { type: 'number', description: 'Voxel height. Default 0.25' },
              parentNodePath: { type: 'string', description: 'Parent of the region. Default: the scene root' },
              nodeName: { type: 'string', description: 'Name of the region. Default: NavigationRegion3D' },
              runScripts: { type: 'boolean', description: 'Keep the scripts of the scene when reading its geometry (for scenes that build their geometry in _ready). Default false' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'render_scene_3d',
          description: 'Draw a 3D scene from several viewpoints (iso, front, back, left, right, top) and return one PNG per view. The camera frames everything the scene shows, and a sun and an environment are added when the scene has none. It opens a short-lived Godot window, so it needs a display and a graphics driver (it does not work headless).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              views: { type: 'array', items: { type: 'string', enum: ['iso', 'front', 'back', 'left', 'right', 'top'] }, description: 'Viewpoints, 1 to 6. Default ["iso"]' },
              width: { type: 'number', description: 'Image width in pixels, 64 to 2048. Default 640' },
              height: { type: 'number', description: 'Image height in pixels, 64 to 2048. Default 480' },
              light: { type: 'string', enum: ['auto', 'none'], description: 'auto (default) adds a sun and an environment when the scene has none; none leaves the scene as it is' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'build_ui',
          description: 'Build a tree of Control nodes from a JSON spec and add it to a scene, or create the scene when it does not exist (the spec root becomes its root). Every node is {type, name, props, children}. props are properties of the node (text, custom_minimum_size [x, y], horizontal_alignment "center", ...) plus shortcuts: anchors (a preset such as full_rect, center, top_wide), margins (a number, or {left, top, right, bottom}, for MarginContainer), separation, size_flags_horizontal / size_flags_vertical (fill, expand, expand_fill, shrink_begin, shrink_center, shrink_end), theme_constants, theme_colors, theme_font_sizes. Colors are "#rrggbb" and vectors are [x, y]. Anchors are ignored inside containers.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project, ending in .tscn. Created when it does not exist (it must not inherit from another scene)' },
              tree: { type: 'object', description: 'The root node of the UI: {"type": "VBoxContainer", "name": "Menu", "props": {"anchors": "center", "separation": 12}, "children": [{"type": "Label", "props": {"text": "Title"}}, {"type": "Button", "name": "Play", "props": {"text": "Play"}}]}. Up to 12 levels and 500 nodes' },
              parentNodePath: { type: 'string', description: 'When the scene exists: parent of the tree, such as "Main" or "Main/Hud". Default: the scene root' },
            },
            required: ['projectPath', 'scenePath', 'tree'],
          },
        },
        {
          name: 'make_theme',
          description: 'Create a Theme (.tres) from a palette: states of Button (normal, hover, pressed, disabled, focus), the type variations PrimaryButton, AccentButton and DangerButton, Panel, PanelContainer, Label, LineEdit, CheckBox, CheckButton, OptionButton and ProgressBar. Text colors are chosen for contrast. Optionally set it as the theme of a node.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              outputPath: { type: 'string', description: 'Where to save the theme, relative to the project, ending in .tres' },
              palette: { type: 'object', description: 'Colors as "#rrggbb": background, text, primary, accent, danger. Defaults: a dark theme with a blue primary' },
              radius: { type: 'number', description: 'Corner radius in pixels. Default 6' },
              borderWidth: { type: 'number', description: 'Border width in pixels. Default 1' },
              padding: { type: 'number', description: 'Inner margin of buttons, fields and panels. Default 10' },
              fontSize: { type: 'number', description: 'Default font size. Default 16' },
              fontPath: { type: 'string', description: 'Font file (.ttf, .otf) to use as the default font' },
              scenePath: { type: 'string', description: 'Optional scene with a Control that gets this theme' },
              nodePath: { type: 'string', description: 'With scenePath: the Control, starting with the root name' },
            },
            required: ['projectPath', 'outputPath'],
          },
        },
        {
          name: 'render_scene_ui',
          description: 'Draw a UI scene at several screen sizes and return one PNG per size, to see how the layout behaves. Sizes are presets (small 320x568, phone 390x844, tablet 1024x768, hd 1280x720, fhd 1920x1080, 4k 3840x2160) or "WIDTHxHEIGHT". It opens a short-lived Godot window, so it needs a display and a graphics driver (it does not work headless).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              sizes: { type: 'array', items: { type: 'string' }, description: 'Up to 6 sizes. Default ["hd"]' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'ui_lint',
          description: 'Check a UI scene for layout problems at one or more screen sizes: controls outside or sticking out of the screen, text that is cut off or wider than its box, controls that overflow their parent, touch targets that are too small, controls that cover buttons and block clicks, overlapping labels. Every problem has the node path, a severity and a suggestion. Needs a display and a graphics driver.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              sizes: { type: 'array', items: { type: 'string' }, description: 'Up to 4 sizes (presets or "WIDTHxHEIGHT"). Default ["hd"]' },
              pseudoLocalize: { type: 'boolean', description: 'Make every text about 40 % longer, with accents, to see how the layout copes with other languages. Default false' },
              minTouchSize: { type: 'number', description: 'Smallest comfortable size of a button or field in pixels; 0 turns the check off. Default 44' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'ui_check_focus',
          description: 'Check that a UI scene can be used with a keyboard or a gamepad: lists the controls that take focus, follows the arrow keys and Tab from the first one, and reports controls that cannot be reached, dead ends, focus neighbors that do not exist, an empty focus style and a screen that opens without focus. Needs a display and a graphics driver.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              sizes: { type: 'array', items: { type: 'string' }, description: 'Up to 4 sizes. Default ["hd"]' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'ui_check_contrast',
          description: 'Check the contrast of every text of a UI scene (labels, buttons, fields) against the background that is actually drawn behind it, with the WCAG limits (4.5:1, or 3:1 for large text). Failures come with a text color that passes. Disabled controls are skipped. Needs a display and a graphics driver.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              sizes: { type: 'array', items: { type: 'string' }, description: 'Up to 4 sizes. Default ["hd"]' },
              pseudoLocalize: { type: 'boolean', description: 'Check the texts after making them longer. Default false' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'create_particles',
          description: 'Add a particle system to a scene from a preset (fire, smoke, sparks, explosion, rain, snow, magic, dust), with any value of the preset changed. It makes the node, its ParticleProcessMaterial, curves, color ramp, texture and (in 3D) a billboard mesh. Works in 2D and 3D, and can make CPU particles for weak devices. Use render_particles to see the result.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project (it must not inherit from another scene)' },
              dimension: { type: 'string', enum: ['2d', '3d'], description: 'Default 3d' },
              nodeName: { type: 'string', description: 'Name of the node. Default: the preset name' },
              parentNodePath: { type: 'string', description: 'Parent of the node. Default: the scene root' },
              position: { type: 'array', items: { type: 'number' }, description: 'Position [x, y] in 2D or [x, y, z] in 3D' },
              size: { type: 'number', description: 'Size of each particle in meters (pixels / 64 in 2D)' },
              cpu: { type: 'boolean', description: 'Make CPUParticles instead of GPUParticles. Default false' },
              preset: { type: 'string', enum: ['fire', 'smoke', 'sparks', 'explosion', 'rain', 'snow', 'magic', 'dust'], description: 'Starting point. Default fire' },
              amount: { type: 'number', description: 'Number of particles alive at once, 1 to 5000' },
              lifetime: { type: 'number', description: 'Seconds a particle lives, 0.05 to 60' },
              oneShot: { type: 'boolean', description: 'Emit once instead of continuously' },
              explosiveness: { type: 'number', description: '0 spreads the births over the lifetime, 1 makes them all at once' },
              emitting: { type: 'boolean', description: 'Start emitting. Default true' },
              shape: { type: 'string', enum: ['point', 'sphere', 'box', 'ring'], description: 'Where particles are born' },
              extent: { description: 'Size of that shape in meters (pixels / 64 in 2D): a radius for sphere and ring, half sizes [x, y, z] for box' },
              direction: { type: 'array', items: { type: 'number' }, description: 'Where they go, [x, y, z] with +Y up (also in 2D)' },
              spread: { type: 'number', description: 'Cone angle around the direction in degrees, 0 to 180' },
              speedMin: { type: 'number', description: 'Slowest start speed in meters per second (pixels / 64 in 2D)' },
              speedMax: { type: 'number', description: 'Fastest start speed' },
              gravity: { type: 'array', items: { type: 'number' }, description: 'Acceleration [x, y, z] with +Y up. [0, 1, 0] makes particles rise' },
              scaleMin: { type: 'number', description: 'Smallest scale of a particle' },
              scaleMax: { type: 'number', description: 'Largest scale of a particle' },
              colors: { type: 'array', items: { type: 'string' }, description: '1 to 4 colors "#rrggbb" for the life of a particle, from birth to death. They fade out at the end' },
              blend: { type: 'string', enum: ['add', 'mix'], description: 'add makes light (fire, magic); mix is for smoke and snow' },
              texture: { type: 'string', enum: ['soft', 'spark', 'streak'], description: 'Generated shape of each particle' },
              texturePath: { type: 'string', description: 'Your own texture, relative to the project, instead of a generated one' },
              turbulence: { type: 'number', description: 'Strength of the swirling noise, 0 for none' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'tune_particles',
          description: 'Change values of an existing GPUParticles2D or GPUParticles3D node: only what you pass changes. The units and options are the same as in create_particles.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              nodePath: { type: 'string', description: 'The particles node, starting with the root name, for example "Main/Fire"' },
              amount: { type: 'number', description: 'Number of particles alive at once, 1 to 5000' },
              lifetime: { type: 'number', description: 'Seconds a particle lives, 0.05 to 60' },
              oneShot: { type: 'boolean', description: 'Emit once instead of continuously' },
              explosiveness: { type: 'number', description: '0 spreads the births over the lifetime, 1 makes them all at once' },
              emitting: { type: 'boolean', description: 'Start emitting. Default true' },
              shape: { type: 'string', enum: ['point', 'sphere', 'box', 'ring'], description: 'Where particles are born' },
              extent: { description: 'Size of that shape in meters (pixels / 64 in 2D): a radius for sphere and ring, half sizes [x, y, z] for box' },
              direction: { type: 'array', items: { type: 'number' }, description: 'Where they go, [x, y, z] with +Y up (also in 2D)' },
              spread: { type: 'number', description: 'Cone angle around the direction in degrees, 0 to 180' },
              speedMin: { type: 'number', description: 'Slowest start speed in meters per second (pixels / 64 in 2D)' },
              speedMax: { type: 'number', description: 'Fastest start speed' },
              gravity: { type: 'array', items: { type: 'number' }, description: 'Acceleration [x, y, z] with +Y up. [0, 1, 0] makes particles rise' },
              scaleMin: { type: 'number', description: 'Smallest scale of a particle' },
              scaleMax: { type: 'number', description: 'Largest scale of a particle' },
              colors: { type: 'array', items: { type: 'string' }, description: '1 to 4 colors "#rrggbb" for the life of a particle, from birth to death. They fade out at the end' },
              blend: { type: 'string', enum: ['add', 'mix'], description: 'add makes light (fire, magic); mix is for smoke and snow' },
              texture: { type: 'string', enum: ['soft', 'spark', 'streak'], description: 'Generated shape of each particle' },
              texturePath: { type: 'string', description: 'Your own texture, relative to the project, instead of a generated one' },
              turbulence: { type: 'number', description: 'Strength of the swirling noise, 0 for none' },
            },
            required: ['projectPath', 'scenePath', 'nodePath'],
          },
        },
        {
          name: 'render_particles',
          description: 'Play the particles of a scene and take pictures at chosen moments, side by side in one PNG, with measurements for each: how much of the picture the particles cover, the box that holds them and their brightness. Reports an error when nothing is visible. The pictures use a fixed random seed, so the same scene gives the same result. It opens a short-lived Godot window, so it needs a display and a graphics driver (it does not work headless).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file with GPUParticles or CPUParticles, relative to the project' },
              times: { type: 'array', items: { type: 'number' }, description: 'Seconds after the start, 1 to 8 values in ascending order. Default [0.1, 0.4, 0.8]' },
              width: { type: 'number', description: 'Width of each picture, 64 to 1024. Default 256' },
              height: { type: 'number', description: 'Height of each picture, 64 to 1024. Default 256' },
              zoom: { type: 'number', description: '2D zoom of the camera. Default 1' },
              radius: { type: 'number', description: '3D: meters the camera frames around the emitter. Default: taken from the emitter' },
              background: { type: 'string', description: 'Color behind the particles, "#rrggbb". Default black' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'checkpoint',
          description: 'Save and restore the state of the project files (scenes, resources, scripts, shaders, project.godot) so a change can be undone. Checkpoints live in .godot/mcp_checkpoints (the newest 20 are kept). Restoring first makes a checkpoint of the current state, so a restore can be undone too. repair_project and move_resource make their own checkpoint before they change anything. Does not need Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              action: { type: 'string', enum: ['create', 'list', 'diff', 'restore', 'delete'], description: 'create saves the files; list shows the checkpoints; diff shows what changed since one; restore puts its files back; delete removes one' },
              id: { type: 'string', description: 'For diff, restore and delete: a checkpoint id from list, or "latest"' },
              label: { type: 'string', description: 'For create: a note, such as "before the new level"' },
              paths: { type: 'array', items: { type: 'string' }, description: 'For create: files or folders to cover, relative to the project. Default: the whole project except addons' },
              deleteNew: { type: 'boolean', description: 'For restore: also delete the files created since the checkpoint. Default false' },
            },
            required: ['projectPath', 'action'],
          },
        },
        {
          name: 'validate_project',
          description: 'Check the project files for broken references without running Godot: ext_resource files that do not exist (and where they moved), ids that are not declared, nodes whose parent is missing, duplicate node names, signal connections to nodes or methods that do not exist, autoloads, the main scene and plugins that point to missing files, and preload/load paths in scripts. Every problem has the file, line and a suggestion.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              includeAddons: { type: 'boolean', description: 'Also check the addons folder. Default false' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'repair_project',
          description: 'Fix the broken file paths that validate_project can resolve: a file that moved is found by its uid or by being the only file with that name, and the path is updated in scenes, resources, scripts and project.godot. By default it only reports what it would change; pass apply to make the changes, after a checkpoint. Does not need Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              apply: { type: 'boolean', description: 'Make the changes. Default false (only report)' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'move_resource',
          description: 'Move or rename a file or folder of the project and update every res:// reference to it in scenes, resources, scripts, shaders, project.godot and settings, together with its .import and .uid files. Makes a checkpoint first. The imported copy is rebuilt the next time the project is imported. Does not need Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              from: { type: 'string', description: 'File or folder to move, relative to the project' },
              to: { type: 'string', description: 'New path, relative to the project; it must not exist' },
              apply: { type: 'boolean', description: 'Do the move. Default true; pass false to only list what would change' },
            },
            required: ['projectPath', 'from', 'to'],
          },
        },
        {
          name: 'explain_error',
          description: 'Explain an error message from Godot or from get_debug_output: what kind of error it is, the usual causes and fixes, the file and line, and the code around that line when a project is given. For a node that was not found it also suggests close node names from the scenes that use the script. Does not need Godot.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The error text, including the "at: ... (res://file.gd:12)" lines when there are any' },
              projectPath: { type: 'string', description: 'Optional project, to show the code around the error' },
            },
            required: ['message'],
          },
        },
        {
          name: 'smoke_all_scenes',
          description: 'Open every scene of the project (or the ones you choose), let each run for some frames, and report the errors Godot prints while it does, scene by scene: scenes that do not load, script errors in _ready and _process, missing resources. Runs headless in one Godot process. A scene that hangs is named. Use it after a big change to find what broke.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              frames: { type: 'number', description: 'Frames to run each scene, 1 to 600. Default 10' },
              scenes: { type: 'array', items: { type: 'string' }, description: 'Scenes to check, relative to the project. Default: every scene except addons' },
              include: { type: 'array', items: { type: 'string' }, description: 'Only scenes whose path matches one of these patterns (* is a wildcard; a pattern without * matches anywhere in the path)' },
              exclude: { type: 'array', items: { type: 'string' }, description: 'Skip scenes that match one of these patterns' },
              includeAddons: { type: 'boolean', description: 'Also check scenes inside addons. Default false' },
              failOnWarnings: { type: 'boolean', description: 'Count warnings as failures. Default false' },
              importFirst: { type: 'boolean', description: 'Run godot --import first, for a project that was never opened. Default false' },
              timeoutMs: { type: 'number', description: 'Limit for the whole run, 10000 to 3600000. Default 300000' },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'play_scenario',
          description: 'Play a scene while it follows a scenario, headless, and check what happens. Steps: wait (seconds of game time), frames, press (an input action), key, click [x, y], set (a property), call (a method), assert (a property of a node with ==, !=, <, <=, >, >=, approx, contains, exists, visible), wait_until (an assert that is retried until it holds or times out) and assert_no_errors. Reports each step with the value it saw. Stops at the first failure unless continueOnFail is set.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene to play, relative to the project. Default: the main scene' },
              steps: {
                type: 'array',
                description: 'Steps, 1 to 200. Each is an object with one action, and an optional "name". Examples: {"press": "ui_accept"}, {"wait": 1.5}, {"set": {"node": "Main/Player", "property": "position", "value": "Vector2(10, 0)"}}, {"assert": {"node": "Main/Player", "property": "position:x", "op": ">", "value": 5}}, {"wait_until": {"node": "Main/Hud/Score", "property": "text", "op": "==", "value": "10", "timeout": 5}}, {"call": {"node": "Main/Player", "method": "jump", "args": []}}, {"click": [120, 80]}, {"key": "Space"}, {"assert_no_errors": true}. Node paths start with the root name.',
                items: { type: 'object' },
              },
              timeScale: { type: 'number', description: 'Speed of game time, 0.1 to 20, so long waits take less real time. Default 1' },
              continueOnFail: { type: 'boolean', description: 'Keep going after a failed step. Default false' },
              timeoutMs: { type: 'number', description: 'Limit in real time, 10000 to 600000. Default 120000' },
            },
            required: ['projectPath', 'steps'],
          },
        },
        {
          name: 'visual_regression',
          description: 'Compare how a scene looks now with a saved picture, pixel by pixel. The first time (or with mode update) it saves the picture in tests/visual; later it draws the scene again and reports how many pixels differ, with a picture of the difference. The scene must draw itself (a UI scene, a 2D scene, or a 3D scene with a camera). It opens a short-lived Godot window, so it needs a display and a graphics driver.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              mode: { type: 'string', enum: ['compare', 'update'], description: 'compare (default) checks against the saved picture; update saves a new one' },
              name: { type: 'string', description: 'Name of the picture. Default: the scene file name' },
              width: { type: 'number', description: 'Width in pixels, 64 to 2048. Default 1280' },
              height: { type: 'number', description: 'Height in pixels, 64 to 2048. Default 720' },
              pixelTolerance: { type: 'number', description: 'Largest change of a color channel (0 to 1) that still counts as equal. Default 0.02' },
              maxDifferentPercent: { type: 'number', description: 'Percent of pixels allowed to differ, 0 to 100. Default 0.1' },
              baselineDir: { type: 'string', description: 'Folder of the saved pictures, relative to the project. Default tests/visual' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'perf_budget',
          description: 'Run a scene in a window for a few seconds with the frame limit off and measure frame time (average, p95, p99, max), frames per second, draw calls, nodes, objects and memory. With a budget it reports every limit that is exceeded. It opens a short-lived Godot window, so it needs a display and a graphics driver; the numbers depend on the machine, so compare them with a budget set on the same machine.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scenePath: { type: 'string', description: 'Scene file, relative to the project' },
              seconds: { type: 'number', description: 'Seconds to measure, 1 to 60. Default 3' },
              warmup: { type: 'number', description: 'Seconds to run before measuring, 0 to 10. Default 1' },
              width: { type: 'number', description: 'Viewport width, 64 to 4096. Default 1280' },
              height: { type: 'number', description: 'Viewport height, 64 to 4096. Default 720' },
              budget: { type: 'object', description: 'Limits: maxFrameMsP95, minFps, maxDrawCalls, maxNodes, maxMemoryMb, maxVideoMemoryMb' },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'generate_tests',
          description: 'Write a GUT test file for a GDScript file: it creates the object, checks that it can be created, checks that each signal exists, and adds a pending test for every public function, with the function signature, ready to fill in. Does not need Godot. Run the result with run_tests.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: { type: 'string', description: 'Path to the Godot project directory' },
              scriptPath: { type: 'string', description: 'The .gd file to test, relative to the project' },
              testDir: { type: 'string', description: 'Folder for the test file, relative to the project. Default test/unit' },
              overwrite: { type: 'boolean', description: 'Replace the test file if it exists (a checkpoint is made first). Default false' },
            },
            required: ['projectPath', 'scriptPath'],
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
        case 'import_spritesheet':
          return await this.handleImportSpritesheet(request.params.arguments);
        case 'auto_collision':
          return await this.handleAutoCollision(request.params.arguments);
        case 'build_tilemap':
          return await this.handleBuildTilemap(request.params.arguments);
        case 'setup_parallax_2d':
          return await this.handleSetupParallax2d(request.params.arguments);
        case 'render_scene_2d':
          return await this.handleRenderScene2d(request.params.arguments);
        case 'build_blockout':
          return await this.handleBuildBlockout(request.params.arguments);
        case 'create_pbr_material':
          return await this.handleCreatePbrMaterial(request.params.arguments);
        case 'scatter_multimesh':
          return await this.handleScatterMultimesh(request.params.arguments);
        case 'bake_navmesh':
          return await this.handleBakeNavmesh(request.params.arguments);
        case 'render_scene_3d':
          return await this.handleRenderScene3d(request.params.arguments);
        case 'build_ui':
          return await this.handleBuildUi(request.params.arguments);
        case 'make_theme':
          return await this.handleMakeTheme(request.params.arguments);
        case 'render_scene_ui':
          return await this.handleRenderSceneUi(request.params.arguments);
        case 'ui_lint':
          return await this.handleUiInspect('lint', request.params.arguments);
        case 'ui_check_focus':
          return await this.handleUiInspect('focus', request.params.arguments);
        case 'ui_check_contrast':
          return await this.handleUiInspect('contrast', request.params.arguments);
        case 'create_particles':
          return await this.handleCreateParticles(request.params.arguments);
        case 'tune_particles':
          return await this.handleTuneParticles(request.params.arguments);
        case 'render_particles':
          return await this.handleRenderParticles(request.params.arguments);
        case 'checkpoint':
          return await this.handleCheckpoint(request.params.arguments);
        case 'validate_project':
          return await this.handleValidateProject(request.params.arguments);
        case 'repair_project':
          return await this.handleRepairProject(request.params.arguments);
        case 'move_resource':
          return await this.handleMoveResource(request.params.arguments);
        case 'explain_error':
          return await this.handleExplainError(request.params.arguments);
        case 'smoke_all_scenes':
          return await this.handleSmokeAllScenes(request.params.arguments);
        case 'play_scenario':
          return await this.handlePlayScenario(request.params.arguments);
        case 'visual_regression':
          return await this.handleVisualRegression(request.params.arguments);
        case 'perf_budget':
          return await this.handlePerfBudget(request.params.arguments);
        case 'generate_tests':
          return await this.handleGenerateTests(request.params.arguments);
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
      // stdio is ignored: nobody reads the editor's output, and an unread pipe fills up and
      // stops the editor once it has written about 64 KB.
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'ignore',
      });

      // Wait for the start, so a wrong GODOT_PATH is reported instead of "launched successfully".
      await new Promise<void>((resolveStart, rejectStart) => {
        process.once('error', rejectStart);
        process.once('spawn', () => resolveStart());
      });
      process.on('error', (err: Error) => {
        console.error('Godot editor error:', err);
      });
      process.unref();

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
   * Split a chunk of process output into whole lines. The text after the last newline is kept
   * and joined to the next chunk, so a line that arrives in two pieces is not cut in two.
   */
  private completeLines(session: GodotProcess, stream: 'output' | 'errors', chunk: string): string[] {
    const parts = (session.partialLine[stream] + chunk).split('\n');
    session.partialLine[stream] = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, ''));
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
        partialLine: { output: '', errors: '' },
      };

      process.stdout?.on('data', (data: Buffer) => {
        const lines = this.completeLines(session, 'output', data.toString());
        this.appendBufferedLines(session, 'output', lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr?.on('data', (data: Buffer) => {
        const lines = this.completeLines(session, 'errors', data.toString());
        this.appendBufferedLines(session, 'errors', lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        // Keep the last line even when it had no newline.
        for (const stream of ['output', 'errors'] as const) {
          if (session.partialLine[stream] !== '') {
            this.appendBufferedLines(session, stream, [session.partialLine[stream]]);
            session.partialLine[stream] = '';
          }
        }
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
   * Shared flow of the 2D tools that edit a scene or resource with godot_operations.gd: check the
   * arguments and the project, run the operation, and report its RESULT line or its failure.
   * `build` turns the checked arguments into the parameters of the operation.
   */
  private async runEditTool(
    rawArgs: any,
    spec: {
      operation: string;
      label: string;
      required: string[];
      build: (args: any) => { params: Record<string, unknown> } | { error: string };
      summary: (result: any) => string;
      // build_ui creates the scene when it does not exist.
      sceneMayBeNew?: boolean;
    }
  ) {
    const args = this.normalizeParameters(rawArgs ?? {});
    for (const key of ['projectPath', ...spec.required]) {
      if (typeof args[key] !== 'string' || args[key] === '') {
        return this.createErrorResponse(`${key} is required and must be text`, [`Provide ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' });
    }
    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' });
    }
    if (typeof args.scenePath === 'string') {
      const sceneFile = join(projectRoot, args.scenePath);
      if (!existsSync(sceneFile) && !spec.sceneMayBeNew) {
        return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project', 'Use create_scene to create it'], { code: 'INVALID_PATH' });
      }
      if (existsSync(sceneFile) && this.isInheritedSceneFile(sceneFile)) {
        return this.createErrorResponse(
          `${args.scenePath} inherits from another scene, and ${spec.label} would re-pack it and lose the inherited content`,
          ['Run the tool on the base scene, or add the nodes with add_node and set_node_property'],
          { code: 'INVALID_ARGUMENT' }
        );
      }
    }
    for (const key of ['texturePath']) {
      if (typeof args[key] === 'string' && !existsSync(join(projectRoot, args[key]))) {
        return this.createErrorResponse(`File does not exist: ${args[key]}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
      }
    }

    const built = spec.build(args);
    if ('error' in built) {
      return this.createErrorResponse(built.error, [`Check the arguments of ${spec.label}`], { code: 'INVALID_ARGUMENT' });
    }

    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH environment variable to specify the correct path'], { code: 'GODOT_NOT_FOUND' });
      }
      const { stdout, stderr } = await this.executeOperation(spec.operation, built.params, args.projectPath);
      const failure = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => line.includes('Failed to'));
      if (failure) {
        return this.createErrorResponse(failure.trim(), ['Check the paths and names with read_scene', 'The project needs Godot 4.3 or later for tiles and parallax']);
      }
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
      if (!line) {
        return this.createErrorResponse(`Godot did not confirm ${spec.label}`, ['Run with GODOT_MCP_DEBUG=true to see the full output']);
      }
      const result = JSON.parse(line.slice('RESULT '.length));
      return {
        content: [
          { type: 'text', text: spec.summary(result) },
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to run ${spec.label}: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']);
    }
  }

  /** Handle the import_spritesheet tool */
  private async handleImportSpritesheet(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'import_spritesheet',
      label: 'import_spritesheet',
      required: ['texturePath', 'outputPath'],
      build: (args) => {
        if (!String(args.outputPath).endsWith('.tres')) {
          return { error: 'outputPath must end in .tres' };
        }
        const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
        const bySize = positive(args.frameWidth) && positive(args.frameHeight);
        const byGrid = positive(args.columns) && positive(args.rows);
        if (!bySize && !byGrid) {
          return { error: 'Give frameWidth and frameHeight, or columns and rows, as numbers above 0' };
        }
        if (args.animations !== undefined) {
          if (!Array.isArray(args.animations)) {
            return { error: 'animations must be a list' };
          }
          for (const animation of args.animations) {
            if (typeof animation !== 'object' || animation === null || typeof animation.name !== 'string' || animation.name === '') {
              return { error: 'Each animation needs a name' };
            }
          }
        }
        if (args.scenePath !== undefined && args.nodeName !== undefined && !/^[^"/\\:@.%]+$/.test(String(args.nodeName))) {
          return { error: 'Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %' };
        }
        const params: Record<string, unknown> = { texturePath: args.texturePath, outputPath: args.outputPath };
        for (const key of ['frameWidth', 'frameHeight', 'columns', 'rows', 'animations', 'scenePath', 'parentNodePath', 'nodeName']) {
          if (args[key] !== undefined) {
            params[key] = args[key];
          }
        }
        return { params };
      },
      summary: (r) => `Saved ${r.output}: ${r.total_frames} frames of ${r.frame_size[0]}x${r.frame_size[1]} px, ${r.animations.length} animation(s)${r.node ? `; added ${r.node}` : ''}.`,
    });
  }

  /** Handle the auto_collision tool */
  private async handleAutoCollision(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'auto_collision',
      label: 'auto_collision',
      required: ['scenePath', 'nodePath'],
      build: (args) => {
        if (args.kind !== undefined && args.kind !== 'collision' && args.kind !== 'occluder') {
          return { error: 'kind must be collision or occluder' };
        }
        for (const key of ['epsilon', 'minArea', 'alphaThreshold']) {
          if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < 0)) {
            return { error: `${key} must be a number, 0 or more` };
          }
        }
        if (args.alphaThreshold !== undefined && args.alphaThreshold > 1) {
          return { error: 'alphaThreshold must be between 0 and 1' };
        }
        const params: Record<string, unknown> = { scenePath: args.scenePath, nodePath: args.nodePath };
        for (const key of ['kind', 'epsilon', 'minArea', 'alphaThreshold', 'targetPath', 'replace']) {
          if (args[key] !== undefined) {
            params[key] = args[key];
          }
        }
        return { params };
      },
      summary: (r) => `Added ${r.polygons} ${r.kind} polygon(s): ${r.nodes.join(', ')}.`,
    });
  }

  /** Handle the build_tilemap tool */
  private async handleBuildTilemap(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'build_tilemap',
      label: 'build_tilemap',
      required: ['scenePath'],
      build: (args) => {
        if (!Array.isArray(args.rows) || args.rows.length === 0 || args.rows.length > 512 || !args.rows.every((row: unknown) => typeof row === 'string')) {
          return { error: 'rows must be a list of 1 to 512 strings' };
        }
        if (typeof args.legend !== 'object' || args.legend === null || Array.isArray(args.legend)) {
          return { error: 'legend must be an object that maps each character to an atlas cell' };
        }
        // Sent as a list: the keys of an object would be renamed to snake_case on the way to Godot.
        const legend: { char: string; x: number; y: number }[] = [];
        for (const [char, cell] of Object.entries(args.legend as Record<string, any>)) {
          const x = Array.isArray(cell) ? cell[0] : cell?.x;
          const y = Array.isArray(cell) ? cell[1] : cell?.y;
          if ([...char].length !== 1 || !Number.isInteger(x) || !Number.isInteger(y)) {
            return { error: `legend entry "${char}" must be one character mapped to {"x": n, "y": n} or [x, y] with whole numbers` };
          }
          legend.push({ char, x, y });
        }
        const used = new Set(args.rows.flatMap((row: string) => [...row]));
        const missing = [...used].filter((c) => c !== '.' && c !== ' ' && !legend.some((entry) => entry.char === c));
        if (missing.length > 0) {
          return { error: `Characters not in the legend: ${missing.join(' ')}` };
        }
        if (args.tileSize !== undefined && !(Number.isInteger(args.tileSize) && args.tileSize > 0)) {
          return { error: 'tileSize must be a whole number above 0' };
        }
        if (args.nodeName !== undefined && !/^[^"/\\:@.%]+$/.test(String(args.nodeName))) {
          return { error: 'Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %' };
        }
        const params: Record<string, unknown> = { scenePath: args.scenePath, rows: args.rows, legend };
        for (const key of ['texturePath', 'tileSetPath', 'tileSize', 'parentNodePath', 'nodeName', 'originX', 'originY']) {
          if (args[key] !== undefined) {
            params[key] = args[key];
          }
        }
        return { params };
      },
      summary: (r) => `Painted ${r.cells} cells on ${r.node}.`,
    });
  }

  /** Handle the setup_parallax_2d tool */
  private async handleSetupParallax2d(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'setup_parallax_2d',
      label: 'setup_parallax_2d',
      required: ['scenePath'],
      build: (args) => {
        if (!Array.isArray(args.layers) || args.layers.length === 0 || args.layers.length > 20) {
          return { error: 'layers must be a list of 1 to 20 layers' };
        }
        const layers: Record<string, unknown>[] = [];
        for (const layer of args.layers) {
          const layerName = layer?.name;
          if (typeof layerName !== 'string' || !/^[^"/\\:@.%]+$/.test(layerName)) {
            return { error: 'Each layer needs a name without slashes, quotes, dots, colons, @ or %' };
          }
          const resolved = this.resolveInsideProject(args.projectPath, layer.texturePath);
          if ('error' in resolved) {
            return { error: `Layer ${layerName}: texturePath: ${resolved.error}` };
          }
          if (!existsSync(join(resolvePath(args.projectPath), resolved.relPath))) {
            return { error: `Layer ${layerName}: texture does not exist: ${resolved.relPath}` };
          }
          const scale = layer.scrollScale ?? 1;
          const scrollX = typeof scale === 'number' ? scale : scale?.x;
          const scrollY = typeof scale === 'number' ? scale : scale?.y;
          if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) {
            return { error: `Layer ${layerName}: scrollScale must be a number or {x, y}` };
          }
          // Snake case on purpose: the keys inside a list are not renamed on the way to Godot.
          layers.push({
            name: layerName,
            texture_path: resolved.relPath,
            scroll_x: scrollX,
            scroll_y: scrollY,
            repeat: layer.repeat === true,
            repeat_times: Number.isInteger(layer.repeatTimes) && layer.repeatTimes > 0 ? layer.repeatTimes : 3,
            z_index: Number.isInteger(layer.zIndex) ? layer.zIndex : 0,
          });
        }
        const params: Record<string, unknown> = { scenePath: args.scenePath, layers };
        if (args.parentNodePath !== undefined) {
          params.parentNodePath = args.parentNodePath;
        }
        return { params };
      },
      summary: (r) => `Added ${r.layers.length} parallax layer(s): ${r.layers.join(', ')}.`,
    });
  }

  /** Handle the render_scene_2d tool: draw a scene in a short-lived Godot window and return the PNG. */
  private async handleRenderScene2d(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    if (typeof args.projectPath !== 'string' || !args.projectPath || typeof args.scenePath !== 'string' || !args.scenePath) {
      return this.createErrorResponse('projectPath and scenePath are required', ['Provide both as text'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' });
    }
    const number = (value: unknown, fallback: number, min: number, max: number): number | undefined => {
      if (value === undefined) return fallback;
      return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    };
    const width = number(args.width, 1280, 64, 4096);
    const height = number(args.height, 720, 64, 4096);
    const zoom = number(args.zoom, 1, 0.01, 100);
    if (width === undefined || height === undefined || zoom === undefined) {
      return this.createErrorResponse('width and height must be 64 to 4096, and zoom 0.01 to 100', ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    const hasCenter = args.centerX !== undefined || args.centerY !== undefined;
    if (hasCenter && !(Number.isFinite(args.centerX) && Number.isFinite(args.centerY))) {
      return this.createErrorResponse('centerX and centerY must both be numbers', ['Give both, or neither'], { code: 'INVALID_ARGUMENT' });
    }

    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' });
    }
    if (!existsSync(join(projectRoot, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-render-'));
    const outFile = join(tempDir, 'scene.png');
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH environment variable to specify the correct path'], { code: 'GODOT_NOT_FOUND' });
      }
      const scriptArgs = [`res://${args.scenePath}`, outFile, String(zoom), String(width), String(height)];
      if (hasCenter) {
        scriptArgs.push(String(args.centerX), String(args.centerY));
      }
      let output = '';
      try {
        const { stdout, stderr } = await execFileAsync(
          this.godotPath,
          ['--path', projectRoot, '--resolution', `${width}x${height}`, '--script', this.renderScenePath, '--', ...scriptArgs],
          { timeout: 90000, maxBuffer: 16 * 1024 * 1024 }
        );
        output = `${stdout}\n${stderr}`;
      } catch (error: any) {
        if (error?.killed) {
          return this.createErrorResponse('The render did not finish within 90 seconds', ['The scene may be stuck loading, or no display is available'], { code: 'TIMEOUT' });
        }
        if (typeof error?.code !== 'number') {
          throw error;
        }
        output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
      }
      if (!existsSync(outFile)) {
        const reason = output.split(/\r?\n/).find((line) => line.startsWith('RENDER_FAIL')) ?? output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(
          `Godot did not render the scene: ${reason || 'no output'}`,
          ['This tool needs a display and a graphics driver; it cannot run headless or without a display', 'Check the scene with check_project_scripts and verify_game'],
        );
      }
      const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(output));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ scene: args.scenePath, width, height, zoom, scriptErrors: scriptErrors.scriptErrors }, null, 2),
          },
          { type: 'image', data: readFileSync(outFile).toString('base64'), mimeType: 'image/png' },
        ],
        isError: scriptErrors.scriptErrors.length > 0,
      };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to render the scene: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Name that is safe to write in a scene: no slashes, quotes, dots, colons, @ or %. */
  private isSafeNodeName(value: unknown): boolean {
    return typeof value === 'string' && /^[^"/\\:@.%]+$/.test(value);
  }

  /** Copy the listed keys of args that are present into a new params object. */
  private pickParams(args: any, keys: string[], into: Record<string, unknown> = {}): Record<string, unknown> {
    for (const key of keys) {
      if (args[key] !== undefined) {
        into[key] = args[key];
      }
    }
    return into;
  }

  /** The first problem with numeric options (each must be a number within its range), or undefined. */
  private checkNumbers(args: any, limits: Record<string, [number, number]>): string | undefined {
    for (const [key, [min, max]] of Object.entries(limits)) {
      const value = args[key];
      if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)) {
        return `${key} must be a number from ${min} to ${max}`;
      }
    }
    return undefined;
  }

  /** Handle the build_blockout tool */
  private async handleBuildBlockout(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'build_blockout',
      label: 'build_blockout',
      required: ['scenePath'],
      build: (args) => {
        if (!Array.isArray(args.rows) || args.rows.length === 0 || args.rows.length > 256 || !args.rows.every((row: unknown) => typeof row === 'string')) {
          return { error: 'rows must be a list of 1 to 256 strings' };
        }
        if (typeof args.legend !== 'object' || args.legend === null || Array.isArray(args.legend)) {
          return { error: 'legend must be an object that maps each character to its style' };
        }
        // Sent as a list: the keys of an object would be renamed to snake_case on the way to Godot.
        const legend: Record<string, unknown>[] = [];
        for (const [char, style] of Object.entries(args.legend as Record<string, any>)) {
          if ([...char].length !== 1) {
            return { error: `legend key "${char}" must be one character` };
          }
          const problem = this.checkNumbers(style ?? {}, { height: [0.01, 1000], elevation: [-1000, 1000] });
          if (problem) {
            return { error: `legend "${char}": ${problem}` };
          }
          if (style?.color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(String(style.color))) {
            return { error: `legend "${char}": color must look like #8a8a8a` };
          }
          legend.push({ char, height: style?.height ?? 1, elevation: style?.elevation ?? 0, color: style?.color ?? '#9a9a9a', collision: style?.collision !== false });
        }
        const used = new Set<string>(args.rows.flatMap((row: string) => [...row]));
        const missing = [...used].filter((c) => c !== '.' && c !== ' ' && !legend.some((entry) => entry.char === c));
        if (missing.length > 0) {
          return { error: `Characters not in the legend: ${missing.join(' ')}` };
        }
        const cells = args.rows.reduce((sum: number, row: string) => sum + [...row].filter((c) => c !== '.' && c !== ' ').length, 0);
        if (cells === 0 || cells > 20000) {
          return { error: 'rows must have between 1 and 20000 filled cells' };
        }
        const problem = this.checkNumbers(args, { cellSize: [0.05, 100], originX: [-10000, 10000], originZ: [-10000, 10000] });
        if (problem) {
          return { error: problem };
        }
        if (args.nodeName !== undefined && !this.isSafeNodeName(args.nodeName)) {
          return { error: 'Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %' };
        }
        return { params: this.pickParams(args, ['cellSize', 'parentNodePath', 'nodeName', 'originX', 'originZ'], { scenePath: args.scenePath, rows: args.rows, legend }) };
      },
      summary: (r) => `Built ${r.boxes} boxes (${r.cells} cells of ${r.cell_size} m) in ${r.node}.`,
    });
  }

  /** Handle the create_pbr_material tool */
  private async handleCreatePbrMaterial(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'create_pbr_material',
      label: 'create_pbr_material',
      required: ['folder', 'outputPath'],
      build: (args) => {
        if (!String(args.outputPath).endsWith('.tres')) {
          return { error: 'outputPath must end in .tres' };
        }
        if (!existsSync(join(resolvePath(args.projectPath), args.folder))) {
          return { error: `Folder does not exist: ${args.folder}` };
        }
        if (args.scenePath !== undefined && (typeof args.nodePath !== 'string' || args.nodePath === '')) {
          return { error: 'nodePath is required with scenePath' };
        }
        const problem = this.checkNumbers(args, { uvScale: [0.001, 1000] });
        if (problem) {
          return { error: problem };
        }
        return { params: this.pickParams(args, ['uvScale', 'triplanar', 'scenePath', 'nodePath'], { folder: args.folder, outputPath: args.outputPath }) };
      },
      summary: (r) => `Saved ${r.output} with ${r.slots.join(', ')}${r.ignored.length > 0 ? `; ignored ${r.ignored.join(', ')}` : ''}${r.assigned_to ? `; assigned to ${r.assigned_to}` : ''}.`,
    });
  }

  /**
   * Handle the scatter_multimesh tool. Written as text, not with Godot: Godot's headless mode has no
   * rendering server, so it cannot store the transforms of a MultiMesh. The scene file gets a MultiMesh
   * sub-resource with its buffer, and a MultiMeshInstance3D node that uses it.
   */
  private async handleScatterMultimesh(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    for (const key of ['projectPath', 'scenePath']) {
      if (typeof args[key] !== 'string' || args[key] === '') {
        return this.createErrorResponse(`${key} is required and must be text`, [`Provide ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' });
    }
    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' });
    }
    const sceneFile = join(projectRoot, args.scenePath);
    if (!existsSync(sceneFile)) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
    }

    if (args.count !== undefined && !(Number.isInteger(args.count) && args.count >= 1 && args.count <= 5000)) {
      return this.createErrorResponse('count must be a whole number from 1 to 5000', ['Check count'], { code: 'INVALID_ARGUMENT' });
    }
    const problem = this.checkNumbers(args, {
      primitiveSize: [0.01, 1000], centerX: [-100000, 100000], centerZ: [-100000, 100000], y: [-100000, 100000],
      sizeX: [0, 100000], sizeZ: [0, 100000], minScale: [0.001, 1000], maxScale: [0.001, 1000], tiltDegrees: [0, 90], seed: [-1e9, 1e9],
    });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.primitive !== undefined && !['box', 'sphere', 'cylinder', 'cone'].includes(args.primitive)) {
      return this.createErrorResponse('primitive must be box, sphere, cylinder or cone', ['Check primitive'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(String(args.color))) {
      return this.createErrorResponse('color must look like #4f8a3c', ['Check color'], { code: 'INVALID_ARGUMENT' });
    }
    for (const key of ['meshNode', 'meshOutputPath']) {
      if (args[key] !== undefined && typeof args[key] !== 'string') {
        return this.createErrorResponse(`${key} must be text`, [`Check ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }
    const nodeName: string = args.nodeName ?? 'Scatter';
    if (!this.isSafeNodeName(nodeName)) {
      return this.createErrorResponse('Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %', ['Check nodeName'], { code: 'INVALID_ARGUMENT' });
    }
    let meshPath: string | undefined;
    if (args.meshPath !== undefined) {
      if (!/\.(tres|res|obj|glb|gltf|fbx|tscn|scn)$/i.test(String(args.meshPath))) {
        return this.createErrorResponse('meshPath must be a Mesh resource (.tres, .res, .obj) or a model or scene (.glb, .gltf, .fbx, .tscn)', ['Check meshPath, or leave it out to use a primitive'], { code: 'INVALID_ARGUMENT' });
      }
      if (!existsSync(join(projectRoot, args.meshPath))) {
        return this.createErrorResponse(`Mesh does not exist: ${args.meshPath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
      }
      meshPath = String(args.meshPath).replace(/\\/g, '/');
      if (/\.(glb|gltf|fbx|tscn|scn)$/i.test(meshPath)) {
        // The MultiMesh needs a Mesh resource: save the mesh of the model next to it, and use that.
        const base = meshPath.replace(/\.[^./]+$/, '');
        const outputPath: string = args.meshOutputPath ?? `${base}_mesh.res`;
        const resolvedOutput = this.resolveInsideProject(args.projectPath, outputPath);
        if ('error' in resolvedOutput || !/\.(res|tres)$/i.test(outputPath)) {
          return this.createErrorResponse('meshOutputPath must be inside the project and end in .res or .tres', ['Check meshOutputPath'], { code: 'INVALID_PATH' });
        }
        try {
          if (!this.godotPath) {
            await this.detectGodotPath();
          }
          const extracted = await this.executeOperation(
            'extract_mesh',
            { sourcePath: meshPath, outputPath: resolvedOutput.relPath, ...(args.meshNode !== undefined ? { meshNode: args.meshNode } : {}) },
            args.projectPath
          );
          const failure = `${extracted.stdout}\n${extracted.stderr}`.split(/\r?\n/).find((line) => line.includes('Failed to'));
          if (failure) {
            return this.createErrorResponse(failure.trim(), ['Check meshPath and meshNode', 'The model must be imported (godot --headless --import)']);
          }
        } catch (error: any) {
          return this.createErrorResponse(`Failed to extract the mesh: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']);
        }
        meshPath = resolvedOutput.relPath;
      }
    }
    if (this.isInheritedSceneFile(sceneFile)) {
      return this.createErrorResponse(`${args.scenePath} inherits from another scene`, ['Run the tool on the base scene'], { code: 'INVALID_ARGUMENT' });
    }

    const before = readFileSync(sceneFile, 'utf8');
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const rootName = sceneRootName(before);
    const parentPath: string = args.parentNodePath ?? rootName;
    const parentKey = nodeKeyFromPath(parentPath, rootName);
    const lines = before.split(/\r?\n/);
    if (parentKey === null || (parentKey !== '' && !locateNodeSection(lines, parentKey))) {
      return this.createErrorResponse(`Parent node not found: ${parentPath}`, ['Use read_scene to see the node paths (they start with the root name)'], { code: 'INVALID_ARGUMENT' });
    }
    const parentAttribute = parentKey === '' ? '.' : parentKey;
    const newKey = sceneNodeKey(parentAttribute, nodeName);
    if (locateNodeSection(lines, newKey)) {
      return this.createErrorResponse(`A node named ${nodeName} already exists under ${parentPath}`, ['Choose another nodeName'], { code: 'INVALID_ARGUMENT' });
    }

    // Seeded random numbers, so the same call gives the same layout.
    const count: number = args.count ?? 100;
    const seed: number = args.seed ?? 1;
    let state = Math.floor(seed) >>> 0;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = (min: number, max: number): number => min + (max - min) * random();
    const minScale: number = args.minScale ?? 1;
    const maxScale: number = Math.max(args.maxScale ?? 1, minScale);
    const tilt = ((args.tiltDegrees ?? 0) * Math.PI) / 180;
    const [centerX, centerZ, height] = [args.centerX ?? 0, args.centerZ ?? 0, args.y ?? 0];
    const [sizeX, sizeZ] = [args.sizeX ?? 20, args.sizeZ ?? 20];
    const format = (value: number): string => String(Math.round(value * 100000) / 100000);

    const floats: string[] = [];
    for (let i = 0; i < count; i++) {
      const scale = between(minScale, maxScale);
      const yaw = args.randomYaw === false ? 0 : between(0, 2 * Math.PI);
      const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
      // Rotation around the vertical axis: rows of the matrix.
      let m = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
      if (tilt > 0) {
        let [ax, az] = [between(-1, 1), between(-1, 1)];
        const length = Math.hypot(ax, az);
        if (length > 0) {
          [ax, az] = [ax / length, az / length];
          const angle = between(0, tilt);
          const [c, s] = [Math.cos(angle), Math.sin(angle)];
          // Rodrigues' formula for the axis (ax, 0, az), applied after the yaw.
          const r = [
            [c + (1 - c) * ax * ax, -s * az, (1 - c) * ax * az],
            [s * az, c, -s * ax],
            [(1 - c) * ax * az, s * ax, c + (1 - c) * az * az],
          ];
          m = r.map((row) => [0, 1, 2].map((col) => row[0] * m[0][col] + row[1] * m[1][col] + row[2] * m[2][col]));
        }
      }
      const origin = [centerX + between(-sizeX / 2, sizeX / 2), height, centerZ + between(-sizeZ / 2, sizeZ / 2)];
      for (let row = 0; row < 3; row++) {
        floats.push(format(m[row][0] * scale), format(m[row][1] * scale), format(m[row][2] * scale), format(origin[row]));
      }
    }

    const suffix = Math.random().toString(36).slice(2, 7);
    const multiMeshId = `MultiMesh_${suffix}`;
    const blocks: string[][] = [];
    let text = before;
    let meshReference: string;
    if (meshPath) {
      const added = addExternalResource(text, 'Mesh', `res://${meshPath}`);
      text = added.text;
      meshReference = `ExtResource("${added.id}")`;
    } else {
      const size: number = args.primitiveSize ?? 1;
      const hex = String(args.color ?? '#7fb36a').replace('#', '');
      const [red, green, blue] = [0, 2, 4].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(4));
      const materialId = `StandardMaterial3D_${suffix}`;
      const meshId = `Mesh_${suffix}`;
      blocks.push([`[sub_resource type="StandardMaterial3D" id="${materialId}"]`, `albedo_color = Color(${red}, ${green}, ${blue}, 1)`]);
      const shape: Record<string, string[]> = {
        box: ['BoxMesh', `size = Vector3(${size}, ${size}, ${size})`],
        sphere: ['SphereMesh', `radius = ${size / 2}`, `height = ${size}`],
        cylinder: ['CylinderMesh', `top_radius = ${size / 4}`, `bottom_radius = ${size / 4}`, `height = ${size}`],
        cone: ['CylinderMesh', 'top_radius = 0.0', `bottom_radius = ${size / 2}`, `height = ${size}`],
      };
      const [meshType, ...meshLines] = shape[args.primitive ?? 'box'];
      blocks.push([`[sub_resource type="${meshType}" id="${meshId}"]`, ...meshLines, `material = SubResource("${materialId}")`]);
      meshReference = `SubResource("${meshId}")`;
    }
    blocks.push([
      `[sub_resource type="MultiMesh" id="${multiMeshId}"]`,
      'transform_format = 1',
      `instance_count = ${count}`,
      `mesh = ${meshReference}`,
      `buffer = PackedFloat32Array(${floats.join(', ')})`,
    ]);

    // Sub-resources go before the first node, where Godot writes them.
    const textLines = text.split(/\r?\n/);
    let firstNode = textLines.findIndex((line) => line.startsWith('[node'));
    if (firstNode === -1) {
      firstNode = textLines.length;
    }
    textLines.splice(firstNode, 0, ...blocks.flatMap((block) => [...block, '']));
    text = appendNodeSection(textLines.join(eol), nodeName, 'MultiMeshInstance3D', parentAttribute);
    text = setSceneProperty(text, newKey, 'multimesh', `SubResource("${multiMeshId}")`);
    writeFileSync(sceneFile, text);

    // Godot must still load the scene with the new node in it; otherwise the file goes back as it was.
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      const nodePath = parentKey === '' ? `${rootName}/${nodeName}` : `${rootName}/${parentKey}/${nodeName}`;
      const problemAfter = await this.verifyOrRestore(args.projectPath, sceneFile, before, [{ params: { scenePath: args.scenePath, nodePath }, mode: 'exists' }]);
      if (problemAfter) {
        return this.createErrorResponse(problemAfter, ['Check meshPath: it must be a Mesh resource'], { code: 'OPERATION_FAILED' });
      }
    } catch (error: any) {
      writeFileSync(sceneFile, before);
      return this.createErrorResponse(`Failed to check the scene after scattering: ${error?.message || 'Unknown error'}. The scene file was restored.`, ['Ensure Godot is installed and GODOT_PATH is set correctly']);
    }

    const result = { node: nodeName, instances: count, seed };
    return {
      content: [
        { type: 'text', text: `Scattered ${count} copies in ${nodeName} (seed ${seed}).` },
        { type: 'text', text: JSON.stringify(result, null, 2) },
      ],
    };
  }

  /** Handle the bake_navmesh tool */
  private async handleBakeNavmesh(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'bake_navmesh',
      label: 'bake_navmesh',
      required: ['scenePath'],
      build: (args) => {
        if (args.parsedGeometry !== undefined && !['meshes', 'colliders', 'both'].includes(args.parsedGeometry)) {
          return { error: 'parsedGeometry must be meshes, colliders or both' };
        }
        const problem = this.checkNumbers(args, {
          agentRadius: [0.01, 100], agentHeight: [0.01, 100], agentMaxClimb: [0, 100], agentMaxSlope: [0, 90], cellSize: [0.01, 10], cellHeight: [0.01, 10],
        });
        if (problem) {
          return { error: problem };
        }
        if (args.nodeName !== undefined && !this.isSafeNodeName(args.nodeName)) {
          return { error: 'Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %' };
        }
        return {
          params: this.pickParams(args, ['geometryPath', 'parsedGeometry', 'agentRadius', 'agentHeight', 'agentMaxClimb', 'agentMaxSlope', 'cellSize', 'cellHeight', 'parentNodePath', 'nodeName', 'runScripts'], { scenePath: args.scenePath }),
        };
      },
      summary: (r) => `Baked ${r.polygons} polygons (${r.vertices} vertices) in ${r.node}.`,
    });
  }

  /** Handle the render_scene_3d tool: draw a scene from several viewpoints and return one PNG per view. */
  private async handleRenderScene3d(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    if (typeof args.projectPath !== 'string' || !args.projectPath || typeof args.scenePath !== 'string' || !args.scenePath) {
      return this.createErrorResponse('projectPath and scenePath are required', ['Provide both as text'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' });
    }
    const allViews = ['iso', 'front', 'back', 'left', 'right', 'top'];
    const views: unknown = args.views ?? ['iso'];
    if (!Array.isArray(views) || views.length === 0 || views.length > 6 || !views.every((v) => allViews.includes(v)) || new Set(views).size !== views.length) {
      return this.createErrorResponse(`views must be 1 to 6 different values from: ${allViews.join(', ')}`, ['Check views'], { code: 'INVALID_ARGUMENT' });
    }
    const problem = this.checkNumbers(args, { width: [64, 2048], height: [64, 2048] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.light !== undefined && args.light !== 'auto' && args.light !== 'none') {
      return this.createErrorResponse('light must be auto or none', ['Check light'], { code: 'INVALID_ARGUMENT' });
    }
    const width: number = args.width ?? 640;
    const height: number = args.height ?? 480;

    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' });
    }
    if (!existsSync(join(projectRoot, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-render3d-'));
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        return this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH environment variable to specify the correct path'], { code: 'GODOT_NOT_FOUND' });
      }
      let output = '';
      try {
        const { stdout, stderr } = await execFileAsync(
          this.godotPath,
          [
            '--path', projectRoot, '--resolution', `${width}x${height}`, '--script', this.renderScene3dPath, '--',
            `res://${args.scenePath}`, tempDir, (views as string[]).join(','), args.light ?? 'auto',
          ],
          { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
        );
        output = `${stdout}\n${stderr}`;
      } catch (error: any) {
        if (error?.killed) {
          return this.createErrorResponse('The render did not finish within 120 seconds', ['The scene may be stuck loading, or no display is available'], { code: 'TIMEOUT' });
        }
        if (typeof error?.code !== 'number') {
          throw error;
        }
        output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
      }
      const rendered = (views as string[]).filter((view) => existsSync(join(tempDir, `${view}.png`)));
      if (rendered.length === 0) {
        const reason = output.split(/\r?\n/).find((line) => line.startsWith('RENDER_FAIL')) ?? output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(
          `Godot did not render the scene: ${reason || 'no output'}`,
          ['This tool needs a display and a graphics driver; it cannot run headless or without a display', 'Check the scene with check_project_scripts and verify_game'],
        );
      }
      const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(output));
      const content: any[] = [
        {
          type: 'text',
          text: JSON.stringify({ scene: args.scenePath, width, height, views: rendered, missingViews: (views as string[]).filter((v) => !rendered.includes(v)), scriptErrors: scriptErrors.scriptErrors }, null, 2),
        },
      ];
      for (const view of rendered) {
        content.push({ type: 'text', text: `View: ${view}` });
        content.push({ type: 'image', data: readFileSync(join(tempDir, `${view}.png`)).toString('base64'), mimeType: 'image/png' });
      }
      return { content, isError: rendered.length < (views as string[]).length || scriptErrors.scriptErrors.length > 0 };
    } catch (error: any) {
      return this.createErrorResponse(`Failed to render the scene: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Property names of a UI spec in snake_case, which is what Godot calls them. */
  private snakeCaseKey(key: string): string {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  /**
   * Check one node of a UI spec ({type, name, props, children}) and its children, and return it with its
   * property names in snake_case. Lists inside the spec are not renamed on the way to Godot, so this is done here.
   */
  private normalizeUiNode(node: any, depth: number, state: { count: number }): { node: Record<string, unknown> } | { error: string } {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return { error: 'Every node of the tree must be an object like {"type": "Button", "props": {...}}' };
    }
    if (depth > 12) {
      return { error: 'The tree is more than 12 levels deep' };
    }
    state.count += 1;
    if (state.count > 500) {
      return { error: 'The tree has more than 500 nodes' };
    }
    if (typeof node.type !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(node.type)) {
      return { error: `Invalid node type: ${String(node.type)}. Use a Control class such as VBoxContainer or Button` };
    }
    if (node.name !== undefined && !this.isSafeNodeName(node.name)) {
      return { error: `Invalid node name: ${String(node.name)}. It cannot contain slashes, quotes, dots, colons, @ or %` };
    }
    const props: Record<string, unknown> = {};
    if (node.props !== undefined) {
      if (typeof node.props !== 'object' || node.props === null || Array.isArray(node.props)) {
        return { error: `props of ${node.name ?? node.type} must be an object` };
      }
      for (const [rawKey, value] of Object.entries(node.props as Record<string, unknown>)) {
        const key = this.snakeCaseKey(rawKey);
        if (!/^[a-z][a-z0-9_]*$/.test(key)) {
          return { error: `Invalid property name: ${rawKey}` };
        }
        if (key === 'script') {
          return { error: 'script cannot be set from a UI spec' };
        }
        if (['theme_constants', 'theme_colors', 'theme_font_sizes', 'margins'].includes(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
          props[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [this.snakeCaseKey(k), v]));
        } else {
          props[key] = value;
        }
      }
    }
    const children: Record<string, unknown>[] = [];
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        return { error: `children of ${node.name ?? node.type} must be a list` };
      }
      for (const child of node.children) {
        const result = this.normalizeUiNode(child, depth + 1, state);
        if ('error' in result) {
          return result;
        }
        children.push(result.node);
      }
    }
    return { node: { type: node.type, ...(node.name !== undefined ? { name: node.name } : {}), props, children } };
  }

  /** Handle the build_ui tool */
  private async handleBuildUi(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'build_ui',
      label: 'build_ui',
      required: ['scenePath'],
      sceneMayBeNew: true,
      build: (args) => {
        if (!String(args.scenePath).endsWith('.tscn')) {
          return { error: 'scenePath must end in .tscn' };
        }
        if (typeof args.tree !== 'object' || args.tree === null || Array.isArray(args.tree)) {
          return { error: 'tree must be an object with the root node of the UI' };
        }
        const normalized = this.normalizeUiNode(args.tree, 1, { count: 0 });
        if ('error' in normalized) {
          return { error: normalized.error };
        }
        return { params: this.pickParams(args, ['parentNodePath'], { scenePath: args.scenePath, tree: normalized.node }) };
      },
      summary: (r) => `${r.created_scene ? 'Created the scene with' : 'Added'} ${r.nodes} node(s) at ${r.root}${r.warnings.length > 0 ? `. Warnings: ${r.warnings.join('; ')}` : ''}.`,
    });
  }

  /** Handle the make_theme tool */
  private async handleMakeTheme(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'make_theme',
      label: 'make_theme',
      required: ['outputPath'],
      build: (args) => {
        if (!String(args.outputPath).endsWith('.tres')) {
          return { error: 'outputPath must end in .tres' };
        }
        if (args.palette !== undefined) {
          if (typeof args.palette !== 'object' || args.palette === null || Array.isArray(args.palette)) {
            return { error: 'palette must be an object like {"primary": "#4f8cff"}' };
          }
          for (const [key, value] of Object.entries(args.palette as Record<string, unknown>)) {
            if (!['background', 'text', 'primary', 'accent', 'danger'].includes(key)) {
              return { error: `palette accepts background, text, primary, accent and danger; not ${key}` };
            }
            if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) {
              return { error: `palette.${key} must look like #4f8cff` };
            }
          }
        }
        const problem = this.checkNumbers(args, { radius: [0, 64], borderWidth: [0, 16], padding: [0, 64], fontSize: [6, 200] });
        if (problem) {
          return { error: problem };
        }
        if (args.scenePath !== undefined && (typeof args.nodePath !== 'string' || args.nodePath === '')) {
          return { error: 'nodePath is required with scenePath' };
        }
        if (args.fontPath !== undefined && !existsSync(join(resolvePath(args.projectPath), String(args.fontPath)))) {
          return { error: `Font does not exist: ${args.fontPath}` };
        }
        return { params: this.pickParams(args, ['palette', 'radius', 'borderWidth', 'padding', 'fontSize', 'fontPath', 'scenePath', 'nodePath'], { outputPath: args.outputPath }) };
      },
      summary: (r) => `Saved ${r.output} with styles for ${r.types.join(', ')}${r.assigned_to ? `; set on ${r.assigned_to}` : ''}.`,
    });
  }

  /** Sizes as [width, height] from presets, "WIDTHxHEIGHT" strings or [w, h] pairs; or an error text. */
  private parseUiSizes(value: unknown, max: number): number[][] | string {
    const presets: Record<string, number[]> = { small: [320, 568], phone: [390, 844], tablet: [1024, 768], hd: [1280, 720], fhd: [1920, 1080], '4k': [3840, 2160] };
    const list: unknown[] = value === undefined ? ['hd'] : Array.isArray(value) ? value : [value];
    if (list.length === 0 || list.length > max) {
      return `sizes must have 1 to ${max} entries`;
    }
    const sizes: number[][] = [];
    for (const entry of list) {
      let size: number[] | undefined;
      if (typeof entry === 'string' && presets[entry]) {
        size = presets[entry];
      } else if (typeof entry === 'string' && /^\d{2,4}x\d{2,4}$/.test(entry)) {
        size = entry.split('x').map(Number);
      } else if (Array.isArray(entry) && entry.length === 2 && entry.every((n) => Number.isInteger(n))) {
        size = entry as number[];
      }
      if (!size || size.some((n) => n < 64 || n > 4096)) {
        return `Invalid size ${JSON.stringify(entry)}: use ${Object.keys(presets).join(', ')} or WIDTHxHEIGHT with 64 to 4096`;
      }
      if (sizes.some((other) => other[0] === size![0] && other[1] === size![1])) {
        return `The size ${size[0]}x${size[1]} is repeated`;
      }
      sizes.push(size);
    }
    return sizes;
  }

  /**
   * Run one of the windowed UI scripts (they need a renderer). Returns Godot's output, or an error response
   * when Godot could not start or timed out.
   */
  private async runWindowedScript(script: string, projectRoot: string, scriptArgs: string[], timeoutMs: number): Promise<{ output: string } | { error: any }> {
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        return { error: this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH environment variable to specify the correct path'], { code: 'GODOT_NOT_FOUND' }) };
      }
      const { stdout, stderr } = await execFileAsync(
        this.godotPath,
        ['--path', projectRoot, '--script', script, '--', ...scriptArgs],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
      );
      return { output: `${stdout}\n${stderr}` };
    } catch (error: any) {
      if (error?.killed) {
        return { error: this.createErrorResponse(`Godot did not finish within ${Math.round(timeoutMs / 1000)} seconds`, ['The scene may be stuck loading, or no display is available'], { code: 'TIMEOUT' }) };
      }
      if (typeof error?.code !== 'number') {
        return { error: this.createErrorResponse(`Failed to run Godot: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']) };
      }
      return { output: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}` };
    }
  }

  /** The common checks of the windowed UI tools: project, scene and sizes. */
  private checkUiTarget(args: any, maxSizes: number): { projectRoot: string; sizes: number[][] } | { error: any } {
    if (typeof args.projectPath !== 'string' || !args.projectPath || typeof args.scenePath !== 'string' || !args.scenePath) {
      return { error: this.createErrorResponse('projectPath and scenePath are required', ['Provide both as text'], { code: 'INVALID_ARGUMENT' }) };
    }
    if (!this.validatePath(args.projectPath)) {
      return { error: this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' }) };
    }
    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return { error: this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' }) };
    }
    if (!existsSync(join(projectRoot, args.scenePath))) {
      return { error: this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' }) };
    }
    const sizes = this.parseUiSizes(args.sizes, maxSizes);
    if (typeof sizes === 'string') {
      return { error: this.createErrorResponse(sizes, ['Check sizes'], { code: 'INVALID_ARGUMENT' }) };
    }
    return { projectRoot, sizes };
  }

  /** Handle the render_scene_ui tool: one PNG per screen size. */
  private async handleRenderSceneUi(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkUiTarget(args, 6);
    if ('error' in target) {
      return target.error;
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-renderui-'));
    try {
      const labels = target.sizes.map(([w, h]) => `${w}x${h}`);
      const ran = await this.runWindowedScript(this.renderSceneUiPath, target.projectRoot, [`res://${args.scenePath}`, tempDir, labels.join(',')], 120000);
      if ('error' in ran) {
        return ran.error;
      }
      const rendered = labels.filter((label) => existsSync(join(tempDir, `${label}.png`)));
      if (rendered.length === 0) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('RENDER_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(
          `Godot did not render the scene: ${reason || 'no output'}`,
          ['This tool needs a display and a graphics driver; it cannot run headless or without a display', 'Check the scene with check_project_scripts']
        );
      }
      const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(ran.output));
      const content: any[] = [
        { type: 'text', text: JSON.stringify({ scene: args.scenePath, sizes: rendered, missingSizes: labels.filter((l) => !rendered.includes(l)), scriptErrors: scriptErrors.scriptErrors }, null, 2) },
      ];
      for (const label of rendered) {
        content.push({ type: 'text', text: `Size: ${label}` });
        content.push({ type: 'image', data: readFileSync(join(tempDir, `${label}.png`)).toString('base64'), mimeType: 'image/png' });
      }
      return { content, isError: rendered.length < labels.length || scriptErrors.scriptErrors.length > 0 };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Handle ui_lint, ui_check_focus and ui_check_contrast: run inspect_ui.gd once per size and join the results. */
  private async handleUiInspect(mode: 'lint' | 'focus' | 'contrast', rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkUiTarget(args, 4);
    if ('error' in target) {
      return target.error;
    }
    const problem = this.checkNumbers(args, { minTouchSize: [0, 500] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check minTouchSize'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.pseudoLocalize !== undefined && typeof args.pseudoLocalize !== 'boolean') {
      return this.createErrorResponse('pseudoLocalize must be true or false', ['Check pseudoLocalize'], { code: 'INVALID_ARGUMENT' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-inspectui-'));
    try {
      const results: any[] = [];
      for (const [width, height] of target.sizes) {
        const outFile = join(tempDir, `${width}x${height}.json`);
        const ran = await this.runWindowedScript(
          this.inspectUiPath,
          target.projectRoot,
          [`res://${args.scenePath}`, mode, String(width), String(height), args.pseudoLocalize === true ? '1' : '0', outFile, String(args.minTouchSize ?? 44)],
          120000
        );
        if ('error' in ran) {
          return ran.error;
        }
        if (!existsSync(outFile)) {
          const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('INSPECT_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
          return this.createErrorResponse(
            `Godot did not inspect the scene at ${width}x${height}: ${reason || 'no output'}`,
            ['This tool needs a display and a graphics driver; it cannot run headless or without a display', 'Check the scene with check_project_scripts']
          );
        }
        results.push(JSON.parse(readFileSync(outFile, 'utf8')));
      }

      const failing = results.reduce((sum, r) => sum + (r.counts?.error ?? 0), 0);
      const lines = results.map((r) => `${r.size[0]}x${r.size[1]}: ${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.info} info`);
      const first = results.flatMap((r) => (r.issues as any[]).filter((i) => i.severity !== 'info').slice(0, 5).map((i) => `- [${i.severity}] ${i.node}: ${i.message}`));
      return {
        content: [
          { type: 'text', text: [`${mode} of ${args.scenePath}`, ...lines, ...(first.length > 0 ? ['', ...first.slice(0, 12)] : [])].join('\n') },
          { type: 'text', text: JSON.stringify({ scene: args.scenePath, mode, results }, null, 2) },
        ],
        isError: failing > 0,
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Check the options that create_particles and tune_particles share. Returns the first problem, or undefined. */
  private checkParticleArgs(args: any): string | undefined {
    const problem = this.checkNumbers(args, {
      lifetime: [0.05, 60], explosiveness: [0, 1], spread: [0, 180], speedMin: [0, 1000], speedMax: [0, 1000],
      scaleMin: [0, 100], scaleMax: [0, 100], size: [0.001, 100], turbulence: [0, 20],
    });
    if (problem) {
      return problem;
    }
    if (args.amount !== undefined && !(Number.isInteger(args.amount) && args.amount >= 1 && args.amount <= 5000)) {
      return 'amount must be a whole number from 1 to 5000';
    }
    for (const key of ['oneShot', 'emitting', 'cpu']) {
      if (args[key] !== undefined && typeof args[key] !== 'boolean') {
        return `${key} must be true or false`;
      }
    }
    if (args.shape !== undefined && !['point', 'sphere', 'box', 'ring'].includes(args.shape)) {
      return 'shape must be point, sphere, box or ring';
    }
    if (args.blend !== undefined && !['add', 'mix'].includes(args.blend)) {
      return 'blend must be add or mix';
    }
    if (args.texture !== undefined && !['soft', 'spark', 'streak'].includes(args.texture)) {
      return 'texture must be soft, spark or streak';
    }
    for (const key of ['direction', 'gravity', 'position']) {
      const value = args[key];
      if (value !== undefined && !(Array.isArray(value) && value.length >= 2 && value.length <= 3 && value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))) {
        return `${key} must be a list of 2 or 3 numbers`;
      }
    }
    if (args.extent !== undefined && !(typeof args.extent === 'number' && args.extent >= 0) && !(Array.isArray(args.extent) && args.extent.length >= 2 && args.extent.length <= 3 && args.extent.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))) {
      return 'extent must be a number, or a list of 2 or 3 numbers';
    }
    if (args.colors !== undefined && !(Array.isArray(args.colors) && args.colors.length >= 1 && args.colors.length <= 4 && args.colors.every((c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)))) {
      return 'colors must be 1 to 4 colors like #ffaa00';
    }
    if (args.texturePath !== undefined && typeof args.texturePath !== 'string') {
      return 'texturePath must be text';
    }
    if (args.nodeName !== undefined && !this.isSafeNodeName(args.nodeName)) {
      return 'Invalid nodeName: it cannot contain slashes, quotes, dots, colons, @ or %';
    }
    return undefined;
  }

  private static readonly PARTICLE_OPTION_KEYS = [
    'amount', 'lifetime', 'oneShot', 'explosiveness', 'emitting', 'shape', 'extent', 'direction', 'spread', 'speedMin', 'speedMax',
    'gravity', 'scaleMin', 'scaleMax', 'colors', 'blend', 'texture', 'texturePath', 'turbulence',
  ];

  /** Handle the create_particles tool */
  private async handleCreateParticles(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'create_particles',
      label: 'create_particles',
      required: ['scenePath'],
      build: (args) => {
        if (args.preset !== undefined && !['fire', 'smoke', 'sparks', 'explosion', 'rain', 'snow', 'magic', 'dust'].includes(args.preset)) {
          return { error: 'preset must be fire, smoke, sparks, explosion, rain, snow, magic or dust' };
        }
        if (args.dimension !== undefined && args.dimension !== '2d' && args.dimension !== '3d') {
          return { error: 'dimension must be 2d or 3d' };
        }
        const problem = this.checkParticleArgs(args);
        if (problem) {
          return { error: problem };
        }
        return {
          params: this.pickParams(args, ['preset', 'dimension', 'nodeName', 'parentNodePath', 'position', 'size', 'cpu', ...GodotServer.PARTICLE_OPTION_KEYS], { scenePath: args.scenePath }),
        };
      },
      summary: (r) => `Added ${r.node} (${r.class}, preset ${r.preset}, ${r.amount} particles, ${r.lifetime} s).`,
    });
  }

  /** Handle the tune_particles tool */
  private async handleTuneParticles(rawArgs: any) {
    return this.runEditTool(rawArgs, {
      operation: 'tune_particles',
      label: 'tune_particles',
      required: ['scenePath', 'nodePath'],
      build: (args) => {
        const problem = this.checkParticleArgs(args);
        if (problem) {
          return { error: problem };
        }
        if (args.size !== undefined) {
          return { error: 'size can only be set in create_particles; use scaleMin and scaleMax to resize an existing system' };
        }
        const params = this.pickParams(args, GodotServer.PARTICLE_OPTION_KEYS, { scenePath: args.scenePath, nodePath: args.nodePath });
        if (Object.keys(params).length <= 2) {
          return { error: 'Pass at least one value to change' };
        }
        return { params };
      },
      summary: (r) => `Changed ${r.changed.join(', ')} on ${r.node}.`,
    });
  }

  /** Handle the render_particles tool: a contact sheet of moments of the particles, with measurements. */
  private async handleRenderParticles(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    if (typeof args.projectPath !== 'string' || !args.projectPath || typeof args.scenePath !== 'string' || !args.scenePath) {
      return this.createErrorResponse('projectPath and scenePath are required', ['Provide both as text'], { code: 'INVALID_ARGUMENT' });
    }
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' });
    }
    const times: unknown = args.times ?? [0.1, 0.4, 0.8];
    if (!Array.isArray(times) || times.length < 1 || times.length > 8 || !times.every((t, i) => typeof t === 'number' && t >= 0 && t <= 30 && (i === 0 || t > (times as number[])[i - 1]))) {
      return this.createErrorResponse('times must be 1 to 8 numbers from 0 to 30, each larger than the one before', ['Check times'], { code: 'INVALID_ARGUMENT' });
    }
    const problem = this.checkNumbers(args, { width: [64, 1024], height: [64, 1024], zoom: [0.05, 20], radius: [0, 1000] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.background !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(args.background))) {
      return this.createErrorResponse('background must look like #101010', ['Check background'], { code: 'INVALID_ARGUMENT' });
    }
    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' });
    }
    if (!existsSync(join(projectRoot, args.scenePath))) {
      return this.createErrorResponse(`Scene file does not exist: ${args.scenePath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-particles-'));
    try {
      const sheet = join(tempDir, 'sheet.png');
      const report = join(tempDir, 'report.json');
      const ran = await this.runWindowedScript(
        this.renderParticlesPath,
        projectRoot,
        [
          `res://${args.scenePath}`, sheet, report, (times as number[]).join(','), String(args.width ?? 256), String(args.height ?? 256),
          String(args.zoom ?? 1), String(args.background ?? '#000000'), String(args.radius ?? 0),
        ],
        120000
      );
      if ('error' in ran) {
        return ran.error;
      }
      if (!existsSync(sheet) || !existsSync(report)) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('RENDER_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(
          `Godot did not render the particles: ${reason || 'no output'}`,
          ['This tool needs a display and a graphics driver; it cannot run headless or without a display', 'Check the scene with check_project_scripts']
        );
      }
      const result = JSON.parse(readFileSync(report, 'utf8'));
      const scriptErrors = this.groupScriptErrors(this.parseScriptErrors(ran.output));
      const lines = (result.frames as any[]).map((f) => `t=${f.t} s: covers ${(f.coverage * 100).toFixed(1)} % of the picture, brightness ${f.mean_brightness}`);
      const hasError = (result.issues as any[]).some((i) => i.severity === 'error') || scriptErrors.scriptErrors.length > 0;
      return {
        content: [
          { type: 'text', text: [`Particles of ${args.scenePath}`, ...lines, ...(result.issues as any[]).map((i) => `[${i.severity}] ${i.message}. ${i.suggestion}`)].join('\n') },
          { type: 'text', text: JSON.stringify({ scene: args.scenePath, ...result, scriptErrors: scriptErrors.scriptErrors }, null, 2) },
          { type: 'image', data: readFileSync(sheet).toString('base64'), mimeType: 'image/png' },
        ],
        isError: hasError,
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Check projectPath for the tools that work on files only. Returns the resolved project folder, or an error response. */
  private checkProjectFolder(args: any): { projectRoot: string } | { error: any } {
    if (typeof args?.projectPath !== 'string' || !args.projectPath) {
      return { error: this.createErrorResponse('Project path is required', ['Provide a valid path to a Godot project directory'], { code: 'INVALID_ARGUMENT' }) };
    }
    if (!this.validatePath(args.projectPath)) {
      return { error: this.createErrorResponse('Invalid project path', ['Provide a valid path without ".." segments'], { code: 'INVALID_PATH' }) };
    }
    const projectRoot = resolvePath(args.projectPath);
    if (!existsSync(join(projectRoot, 'project.godot'))) {
      return { error: this.createErrorResponse(`Not a valid Godot project: ${args.projectPath}`, ['Ensure the path points to a directory containing a project.godot file'], { code: 'PROJECT_NOT_FOUND' }) };
    }
    return { projectRoot };
  }

  private textResult(summary: string, details: unknown, isError = false) {
    return {
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: JSON.stringify(details, null, 2) },
      ],
      isError,
    };
  }

  /** Handle the checkpoint tool */
  private async handleCheckpoint(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    const root = target.projectRoot;
    const action = args.action;
    if (!['create', 'list', 'diff', 'restore', 'delete'].includes(action)) {
      return this.createErrorResponse('action must be create, list, diff, restore or delete', ['Check action'], { code: 'INVALID_ARGUMENT' });
    }
    try {
      if (action === 'create') {
        if (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 200)) {
          return this.createErrorResponse('label must be text of up to 200 characters', ['Check label'], { code: 'INVALID_ARGUMENT' });
        }
        let paths: string[] | undefined;
        if (args.paths !== undefined) {
          if (!Array.isArray(args.paths) || args.paths.length > 100 || !args.paths.every((p: unknown) => typeof p === 'string')) {
            return this.createErrorResponse('paths must be a list of up to 100 paths', ['Check paths'], { code: 'INVALID_ARGUMENT' });
          }
          paths = [];
          for (const value of args.paths as string[]) {
            const resolved = this.resolveInsideProject(args.projectPath, value);
            if ('error' in resolved) {
              return this.createErrorResponse(`paths: ${resolved.error}`, ['Use paths inside the project'], { code: 'INVALID_PATH' });
            }
            paths.push(resolved.relPath);
          }
        }
        const manifest = createCheckpoint(root, { label: args.label, paths });
        return this.textResult(`Checkpoint ${manifest.id} saved: ${manifest.files.length} files${manifest.label ? ` (${manifest.label})` : ''}.`, { id: manifest.id, label: manifest.label, files: manifest.files.length });
      }
      if (action === 'list') {
        const all = listCheckpoints(root);
        const summary = all.length === 0 ? 'There are no checkpoints.' : all.map((c) => `${c.id}  ${c.files.length} files  ${c.label}`).join('\n');
        return this.textResult(summary, { checkpoints: all.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, files: c.files.length })) });
      }
      if (typeof args.id !== 'string' || args.id === '') {
        return this.createErrorResponse('id is required (a checkpoint id from list, or "latest")', ['Use action list to see the ids'], { code: 'INVALID_ARGUMENT' });
      }
      if (action === 'delete') {
        return deleteCheckpoint(root, args.id)
          ? this.textResult(`Checkpoint ${args.id} deleted.`, { deleted: args.id })
          : this.createErrorResponse(`Checkpoint not found: ${args.id}`, ['Use action list to see the ids'], { code: 'INVALID_ARGUMENT' });
      }
      const manifest = findCheckpoint(root, args.id);
      if (!manifest) {
        return this.createErrorResponse(`Checkpoint not found: ${args.id}`, ['Use action list to see the ids'], { code: 'INVALID_ARGUMENT' });
      }
      if (action === 'diff') {
        const difference = diffCheckpoint(root, manifest);
        return this.textResult(
          `Since ${manifest.id}: ${difference.changed.length} changed, ${difference.removed.length} removed, ${difference.added.length} new, ${difference.unchanged} unchanged.`,
          difference
        );
      }
      const result = restoreCheckpoint(root, manifest, { deleteNew: args.deleteNew === true });
      return this.textResult(
        `Restored ${result.restored.length} file(s) from ${manifest.id}${result.removed.length > 0 ? ` and deleted ${result.removed.length} new file(s)` : ''}. To undo this, restore ${result.undoCheckpoint}.`,
        result
      );
    } catch (error: any) {
      return this.createErrorResponse(`Checkpoint failed: ${error?.message || 'Unknown error'}`, ['Check that the project folder is writable']);
    }
  }

  /** Handle the validate_project tool */
  private async handleValidateProject(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    try {
      const result = validateProject(target.projectRoot, { includeAddons: args.includeAddons === true });
      const shown = result.issues.filter((i) => i.severity !== 'info').slice(0, 15).map((i) => `- [${i.severity}] ${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}${i.suggestion ? `. ${i.suggestion}` : ''}`);
      const summary = [`Checked ${result.filesChecked} files: ${result.counts.error} error(s), ${result.counts.warning} warning(s), ${result.counts.info} info.`, ...shown].join('\n');
      return this.textResult(summary, { counts: result.counts, filesChecked: result.filesChecked, issues: result.issues.slice(0, 300), issuesOmitted: Math.max(0, result.issues.length - 300) }, result.counts.error > 0);
    } catch (error: any) {
      return this.createErrorResponse(`Failed to check the project: ${error?.message || 'Unknown error'}`, ['Check that the project folder is readable']);
    }
  }

  /** Handle the repair_project tool */
  private async handleRepairProject(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    if (args.apply !== undefined && typeof args.apply !== 'boolean') {
      return this.createErrorResponse('apply must be true or false', ['Check apply'], { code: 'INVALID_ARGUMENT' });
    }
    try {
      const apply = args.apply === true;
      const result = repairProject(target.projectRoot, { apply });
      const lines = result.changes.map((c) => `- ${c.file}: ${c.from} -> ${c.to}${c.occurrences > 1 ? ` (x${c.occurrences})` : ''}`);
      const summary = [
        result.changes.length === 0 ? 'No path can be repaired automatically.' : `${apply ? 'Changed' : 'Would change'} ${result.changes.length} path(s):`,
        ...lines,
        ...(result.unresolved.length > 0 ? ['', `${result.unresolved.length} missing file(s) could not be resolved (use validate_project for the list).`] : []),
        ...(result.checkpoint ? ['', `Checkpoint ${result.checkpoint} was made first; restore it to undo.`] : []),
        ...(!apply && result.changes.length > 0 ? ['', 'Run again with apply set to true to make the changes.'] : []),
      ].join('\n');
      return this.textResult(summary, { applied: apply, ...result, unresolved: result.unresolved.slice(0, 100) });
    } catch (error: any) {
      return this.createErrorResponse(`Failed to repair the project: ${error?.message || 'Unknown error'}`, ['Check that the project folder is writable']);
    }
  }

  /** Handle the move_resource tool */
  private async handleMoveResource(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    for (const key of ['from', 'to']) {
      if (typeof args[key] !== 'string' || args[key] === '') {
        return this.createErrorResponse(`${key} is required and must be text`, [`Provide ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }
    if (args.apply !== undefined && typeof args.apply !== 'boolean') {
      return this.createErrorResponse('apply must be true or false', ['Check apply'], { code: 'INVALID_ARGUMENT' });
    }
    try {
      const apply = args.apply !== false;
      const result = moveResource(target.projectRoot, args.from, args.to, { apply });
      const total = result.updates.reduce((sum, u) => sum + u.occurrences, 0);
      const summary = [
        `${apply ? 'Moved' : 'Would move'} ${args.from} to ${args.to}${result.moved.length > 1 ? ` (with ${result.moved.slice(1).join(', ')})` : ''}.`,
        `${apply ? 'Updated' : 'Would update'} ${total} reference(s) in ${result.updates.length} file(s).`,
        ...(result.checkpoint ? [`Checkpoint ${result.checkpoint} was made first; restore it to undo.`] : []),
      ].join('\n');
      return this.textResult(summary, { applied: apply, ...result });
    } catch (error: any) {
      return this.createErrorResponse(`Failed to move: ${error?.message || 'Unknown error'}`, ['Check that both paths are inside the project and that the target does not exist']);
    }
  }

  /** Handle the explain_error tool */
  private async handleExplainError(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    if (typeof args.message !== 'string' || args.message.trim() === '' || args.message.length > 20000) {
      return this.createErrorResponse('message is required: the error text, up to 20000 characters', ['Paste the error from get_debug_output or the Godot console'], { code: 'INVALID_ARGUMENT' });
    }
    let projectRoot: string | undefined;
    if (args.projectPath !== undefined) {
      const target = this.checkProjectFolder(args);
      if ('error' in target) {
        return target.error;
      }
      projectRoot = target.projectRoot;
    }
    const explanation = explainError(args.message, projectRoot);
    const where = explanation.locations.length > 0 ? ` at ${explanation.locations[0].file}:${explanation.locations[0].line}` : '';
    const context = explanation.context ? ['', ...explanation.context.lines.map((l) => `${l.here ? '>' : ' '} ${String(l.number).padStart(4)} | ${l.text}`)] : [];
    const summary = [
      `${explanation.title}${where}`,
      explanation.explanation,
      '',
      'What to try:',
      ...explanation.fixes.map((f) => `- ${f}`),
      ...(explanation.hints.length > 0 ? ['', ...explanation.hints] : []),
      ...context,
    ].join('\n');
    return this.textResult(summary, explanation);
  }

  /** Run a headless Godot script of this server and return its output, or an error response for a start failure. */
  private async runHeadlessScript(script: string, projectRoot: string, scriptArgs: string[], timeoutMs: number): Promise<{ output: string; timedOut: boolean } | { error: any }> {
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (!this.godotPath) {
        return { error: this.createErrorResponse('Could not find a valid Godot executable path', ['Set GODOT_PATH environment variable to specify the correct path'], { code: 'GODOT_NOT_FOUND' }) };
      }
      const { stdout, stderr } = await execFileAsync(
        this.godotPath,
        ['--headless', '--path', projectRoot, '--script', script, '--', ...scriptArgs],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
      );
      return { output: `${stdout}\n${stderr}`, timedOut: false };
    } catch (error: any) {
      if (error?.killed) {
        return { output: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, timedOut: true };
      }
      if (typeof error?.code !== 'number') {
        return { error: this.createErrorResponse(`Failed to run Godot: ${error?.message || 'Unknown error'}`, ['Ensure Godot is installed and GODOT_PATH is set correctly']) };
      }
      return { output: `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`, timedOut: false };
    }
  }

  private readJsonFile(file: string): any | undefined {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Handle the smoke_all_scenes tool */
  private async handleSmokeAllScenes(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    const projectRoot = target.projectRoot;
    const problem = this.checkNumbers(args, { frames: [1, 600], timeoutMs: [10000, 3600000] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    for (const key of ['scenes', 'include', 'exclude']) {
      if (args[key] !== undefined && !(Array.isArray(args[key]) && args[key].length <= 300 && args[key].every((v: unknown) => typeof v === 'string' && v !== ''))) {
        return this.createErrorResponse(`${key} must be a list of up to 300 texts`, [`Check ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }
    for (const key of ['includeAddons', 'failOnWarnings', 'importFirst']) {
      if (args[key] !== undefined && typeof args[key] !== 'boolean') {
        return this.createErrorResponse(`${key} must be true or false`, [`Check ${key}`], { code: 'INVALID_ARGUMENT' });
      }
    }

    let scenes: string[];
    if (args.scenes !== undefined) {
      scenes = [];
      for (const value of args.scenes as string[]) {
        const resolved = this.resolveInsideProject(args.projectPath, value);
        if ('error' in resolved || !resolved.relPath.endsWith('.tscn') || !existsSync(join(projectRoot, resolved.relPath))) {
          return this.createErrorResponse(`Not a scene of the project: ${value}`, ['Give .tscn paths relative to the project'], { code: 'INVALID_PATH' });
        }
        scenes.push(resolved.relPath);
      }
    } else {
      scenes = this.listProjectFiles(projectRoot, projectRoot, ['tscn']).filter((file) => args.includeAddons === true || !file.startsWith('addons/'));
    }
    const includes = ((args.include ?? []) as string[]).map(globToRegExp);
    const excludes = ((args.exclude ?? []) as string[]).map(globToRegExp);
    scenes = scenes.filter((file) => (includes.length === 0 || includes.some((r) => r.test(file))) && !excludes.some((r) => r.test(file))).sort();
    if (scenes.length === 0) {
      return this.createErrorResponse('No scene to check', ['Check include, exclude and scenes'], { code: 'INVALID_ARGUMENT' });
    }
    if (scenes.length > 300) {
      return this.createErrorResponse(`${scenes.length} scenes is too many for one run (limit 300)`, ['Narrow it down with include or exclude'], { code: 'INVALID_ARGUMENT' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-smoke-'));
    try {
      if (!this.godotPath) {
        await this.detectGodotPath();
      }
      if (this.godotPath && args.importFirst === true) {
        const importOutput = await this.runGodotImport(projectRoot);
        if (importOutput !== undefined) {
          return this.createErrorResponse(`Godot import failed:\n${importOutput.slice(0, 1500)}`, ['Open the project in the Godot editor to see the import errors'], { code: 'IMPORT_FAILED' });
        }
      }
      const listFile = join(tempDir, 'scenes.json');
      const outFile = join(tempDir, 'result.json');
      writeFileSync(listFile, JSON.stringify(scenes.map((file) => `res://${file}`)));
      const timeoutMs: number = args.timeoutMs ?? 300000;
      const ran = await this.runHeadlessScript(this.smokeScenesPath, projectRoot, [listFile, outFile, String(args.frames ?? 10)], timeoutMs);
      if ('error' in ran) {
        return ran.error;
      }
      const data = this.readJsonFile(outFile);
      if (!data) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('SMOKE_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(`The run produced no result: ${reason || 'no output'}`, ['Check the project with diagnose_project and check_project_scripts'], ran.timedOut ? { code: 'TIMEOUT' } : {});
      }
      const results: any[] = data.scenes;
      const stuck = ran.timedOut ? (existsSync(`${outFile}.current`) ? readFileSync(`${outFile}.current`, 'utf8').trim() : undefined) : undefined;
      const failing = results.filter((r) => !r.ok || (args.failOnWarnings === true && r.warnings > 0));
      const lines = [
        `${results.length} of ${scenes.length} scene(s) run for ${args.frames ?? 10} frames: ${results.length - failing.length} ok, ${failing.length} failing.`,
        ...(ran.timedOut ? [`The run stopped after ${Math.round(timeoutMs / 1000)} s${stuck ? ` while it was running ${stuck}` : ''}. The scenes after it were not checked.`] : []),
        ...failing.slice(0, 15).flatMap((r) => [
          `- ${r.scene}${r.load_error ? `: ${r.load_error}` : `: ${r.error_count} error(s)${r.warnings > 0 ? `, ${r.warnings} warning(s)` : ''}`}`,
          ...(r.errors as any[]).slice(0, 3).map((e) => `    ${e.file ? `${e.file}:${e.line} ` : ''}${String(e.message).split('\n')[0].slice(0, 160)}`),
        ]),
      ];
      return this.textResult(lines.join('\n'), { frames: args.frames ?? 10, checked: results.length, total: scenes.length, timedOut: ran.timedOut, stuckScene: stuck, scenes: results }, failing.length > 0 || ran.timedOut);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** The main scene of a project, from project.godot (res:// path), or undefined. */
  private mainSceneOf(projectRoot: string): string | undefined {
    const text = readFileSync(join(projectRoot, 'project.godot'), 'utf8');
    return /^run\/main_scene="([^"]+)"/m.exec(text)?.[1];
  }

  /** Handle the play_scenario tool */
  private async handlePlayScenario(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    const projectRoot = target.projectRoot;
    const problem = this.checkNumbers(args, { timeScale: [0.1, 20], timeoutMs: [10000, 600000] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    let scene: string | undefined;
    if (args.scenePath !== undefined) {
      if (typeof args.scenePath !== 'string' || !existsSync(join(projectRoot, args.scenePath))) {
        return this.createErrorResponse(`Scene file does not exist: ${String(args.scenePath)}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
      }
      scene = `res://${args.scenePath}`;
    } else {
      scene = this.mainSceneOf(projectRoot);
      if (!scene) {
        return this.createErrorResponse('The project has no main scene, and scenePath was not given', ['Pass scenePath'], { code: 'INVALID_ARGUMENT' });
      }
    }
    if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 200) {
      return this.createErrorResponse('steps must be a list of 1 to 200 steps', ['Check steps'], { code: 'INVALID_ARGUMENT' });
    }
    const actions = ['wait', 'frames', 'press', 'key', 'click', 'set', 'call', 'assert', 'wait_until', 'assert_no_errors'];
    const ops = ['==', '!=', '<', '<=', '>', '>=', 'approx', 'contains', 'exists', 'visible'];
    let gameSeconds = 0;
    for (const [index, step] of (args.steps as any[]).entries()) {
      const where = `step ${index + 1}`;
      if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        return this.createErrorResponse(`${where} must be an object`, ['Check steps'], { code: 'INVALID_ARGUMENT' });
      }
      const present = actions.filter((a) => step[a] !== undefined);
      if (present.length !== 1) {
        return this.createErrorResponse(`${where} needs exactly one of: ${actions.join(', ')}`, ['Check steps'], { code: 'INVALID_ARGUMENT' });
      }
      const action = present[0];
      const value = step[action];
      const bad = (message: string) => this.createErrorResponse(`${where}: ${message}`, ['Check steps'], { code: 'INVALID_ARGUMENT' });
      if (step.name !== undefined && (typeof step.name !== 'string' || step.name.length > 80)) {
        return bad('name must be text of up to 80 characters');
      }
      if (action === 'wait') {
        if (typeof value !== 'number' || !(value >= 0 && value <= 60)) return bad('wait must be a number of seconds from 0 to 60');
        gameSeconds += value;
      } else if (action === 'frames') {
        if (!Number.isInteger(value) || value < 1 || value > 3600) return bad('frames must be a whole number from 1 to 3600');
      } else if (action === 'press' || action === 'key') {
        if (typeof value !== 'string' || value === '') return bad(`${action} must be text`);
        if (step.hold !== undefined && !(typeof step.hold === 'number' && step.hold >= 0 && step.hold <= 5)) return bad('hold must be a number from 0 to 5');
        gameSeconds += step.hold ?? 0.1;
      } else if (action === 'click') {
        if (!(Array.isArray(value) && value.length === 2 && value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))) return bad('click must be [x, y]');
        if (step.button !== undefined && step.button !== 'left' && step.button !== 'right') return bad('button must be left or right');
      } else if (action === 'assert_no_errors') {
        if (value !== true) return bad('assert_no_errors must be true');
      } else {
        if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.node !== 'string' || value.node === '') return bad(`${action} needs an object with a node`);
        if (action === 'set' && (typeof value.property !== 'string' || value.property === '' || value.value === undefined)) return bad('set needs property and value');
        if (action === 'call') {
          if (typeof value.method !== 'string' || !/^\w+$/.test(value.method)) return bad('call needs a method name');
          if (value.args !== undefined && !(Array.isArray(value.args) && value.args.length <= 10)) return bad('call args must be a list of up to 10 values');
        }
        if (action === 'assert' || action === 'wait_until') {
          const op = value.op ?? '==';
          if (!ops.includes(op)) return bad(`op must be one of: ${ops.join(' ')}`);
          if (!['exists', 'visible'].includes(op) && (typeof value.property !== 'string' || value.property === '' || value.value === undefined)) return bad(`${action} needs property and value`);
          if (action === 'wait_until') {
            if (value.timeout !== undefined && !(typeof value.timeout === 'number' && value.timeout > 0 && value.timeout <= 60)) return bad('timeout must be a number from 0 to 60');
            gameSeconds += value.timeout ?? 5;
          }
        }
      }
    }
    const timeScale: number = args.timeScale ?? 1;
    if (gameSeconds / timeScale > 300) {
      return this.createErrorResponse('The scenario could take over 300 s of real time', ['Shorten the waits, or raise timeScale'], { code: 'INVALID_ARGUMENT' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-scenario-'));
    try {
      const scenarioFile = join(tempDir, 'scenario.json');
      const outFile = join(tempDir, 'result.json');
      writeFileSync(scenarioFile, JSON.stringify({ scene, time_scale: timeScale, continue_on_fail: args.continueOnFail === true, steps: args.steps }));
      const timeoutMs: number = args.timeoutMs ?? 120000;
      const ran = await this.runHeadlessScript(this.playScenarioPath, projectRoot, [scenarioFile, outFile], timeoutMs);
      if ('error' in ran) {
        return ran.error;
      }
      if (ran.timedOut) {
        return this.createErrorResponse(`The scenario did not finish within ${Math.round(timeoutMs / 1000)} seconds`, ['A step may be waiting for something that never happens; use wait_until with a timeout', 'Raise timeScale to shorten the waits'], { code: 'TIMEOUT' });
      }
      const data = this.readJsonFile(outFile);
      if (!data) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('SCENARIO_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(`The scenario produced no result: ${reason || 'no output'}`, ['Check the scene with check_project_scripts']);
      }
      if (data.fatal) {
        return this.createErrorResponse(data.fatal, ['Check scenePath and that the project is imported']);
      }
      const lines = (data.results as any[]).map((r) => `${r.ok ? 'ok  ' : 'FAIL'} #${r.index + 1}${r.name ? ` ${r.name}` : ''}: ${['wait', 'frames', 'press', 'key', 'click', 'set', 'call', 'assert', 'wait_until', 'assert_no_errors'].find((k) => k in r.step)}${r.message ? ` - ${r.message}` : ''}`);
      const skipped = data.steps_total - data.results.length;
      const summary = [
        `${data.passed} of ${data.steps_total} step(s) passed${data.failed > 0 ? `, ${data.failed} failed` : ''}${skipped > 0 ? `, ${skipped} not run` : ''} in ${data.elapsed_ms} ms.`,
        ...lines,
        ...(data.errors.length > 0 ? ['', `The game printed ${data.errors.length} error(s); the first: ${String(data.errors[0].message).split('\n')[0].slice(0, 160)}`] : []),
      ].join('\n');
      return this.textResult(summary, data, data.failed > 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Handle the visual_regression tool */
  private async handleVisualRegression(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkUiTarget({ ...args, sizes: undefined }, 1);
    if ('error' in target) {
      return target.error;
    }
    const problem = this.checkNumbers(args, { width: [64, 2048], height: [64, 2048], pixelTolerance: [0, 1], maxDifferentPercent: [0, 100] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.mode !== undefined && args.mode !== 'compare' && args.mode !== 'update') {
      return this.createErrorResponse('mode must be compare or update', ['Check mode'], { code: 'INVALID_ARGUMENT' });
    }
    const sceneName = basename(String(args.scenePath)).replace(/\.tscn$/, '');
    const name: string = args.name ?? sceneName;
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(name)) {
      return this.createErrorResponse('name can only have letters, digits, - and _ (up to 60)', ['Check name'], { code: 'INVALID_ARGUMENT' });
    }
    const resolvedDir = this.resolveInsideProject(args.projectPath, args.baselineDir ?? 'tests/visual');
    if ('error' in resolvedDir) {
      return this.createErrorResponse(`baselineDir: ${resolvedDir.error}`, ['Use a folder inside the project'], { code: 'INVALID_PATH' });
    }
    const projectRoot = target.projectRoot;
    const width: number = args.width ?? 1280;
    const height: number = args.height ?? 720;
    const label = `${width}x${height}`;
    const baseline = join(projectRoot, resolvedDir.relPath, `${name}_${label}.png`);
    const baselineRel = `${resolvedDir.relPath}/${name}_${label}.png`;
    const update = args.mode === 'update';
    if (!update && !existsSync(baseline)) {
      return this.createErrorResponse(`There is no saved picture yet: ${baselineRel}`, ['Run with mode update to save the current look as the reference'], { code: 'BASELINE_MISSING' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-visual-'));
    try {
      const ran = await this.runWindowedScript(this.renderSceneUiPath, projectRoot, [`res://${args.scenePath}`, tempDir, label], 120000);
      if ('error' in ran) {
        return ran.error;
      }
      const current = join(tempDir, `${label}.png`);
      if (!existsSync(current)) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('RENDER_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(`Godot did not draw the scene: ${reason || 'no output'}`, ['This tool needs a display and a graphics driver; it cannot run headless or without a display']);
      }
      const image = (file: string) => ({ type: 'image', data: readFileSync(file).toString('base64'), mimeType: 'image/png' });
      if (update) {
        mkdirSync(dirname(baseline), { recursive: true });
        copyFileSync(current, baseline);
        return { content: [{ type: 'text', text: `Saved ${baselineRel} as the reference look of ${args.scenePath}.` }, image(current)], isError: false };
      }

      const diffPng = join(tempDir, 'diff.png');
      const diffJson = join(tempDir, 'diff.json');
      const ranDiff = await this.runHeadlessScript(this.imageDiffPath, projectRoot, [baseline, current, diffPng, String(args.pixelTolerance ?? 0.02), diffJson], 180000);
      if ('error' in ranDiff) {
        return ranDiff.error;
      }
      const result = this.readJsonFile(diffJson);
      if (!result) {
        return this.createErrorResponse(`Godot could not compare the pictures: ${ranDiff.output.trim().split(/\r?\n/).slice(-2).join(' ')}`, ['Check that the saved picture is a PNG']);
      }
      if (result.size_mismatch) {
        return {
          content: [
            { type: 'text', text: `The picture has another size: now ${result.current_size.join('x')}, saved ${result.baseline_size.join('x')}. Save a new reference with mode update if the change is intended.` },
            image(current),
          ],
          isError: true,
        };
      }
      const limit: number = args.maxDifferentPercent ?? 0.1;
      const passes = result.percent <= limit;
      const summary = `${args.scenePath} at ${label}: ${result.different_pixels} of ${result.total_pixels} pixels differ (${result.percent} %, limit ${limit} %), largest change ${result.max_delta}.${passes ? '' : ' Save a new reference with mode update if the change is intended.'}`;
      const content: any[] = [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify({ ...result, baseline: baselineRel, limit, passes }, null, 2) }];
      if (!passes) {
        content.push({ type: 'text', text: 'Difference (red = changed):' }, image(diffPng), { type: 'text', text: 'Now:' }, image(current));
      }
      return { content, isError: !passes };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Handle the perf_budget tool */
  private async handlePerfBudget(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkUiTarget({ ...args, sizes: undefined }, 1);
    if ('error' in target) {
      return target.error;
    }
    const problem = this.checkNumbers(args, { seconds: [1, 60], warmup: [0, 10], width: [64, 4096], height: [64, 4096] });
    if (problem) {
      return this.createErrorResponse(problem, ['Check the numbers'], { code: 'INVALID_ARGUMENT' });
    }
    const budgetKeys: Record<string, [string, 'max' | 'min']> = {
      maxFrameMsP95: ['frame_ms_p95', 'max'], minFps: ['fps', 'min'], maxDrawCalls: ['draw_calls_max', 'max'],
      maxNodes: ['nodes_max', 'max'], maxMemoryMb: ['memory_mb', 'max'], maxVideoMemoryMb: ['video_memory_mb', 'max'],
    };
    const budget: Record<string, number> = {};
    if (args.budget !== undefined) {
      if (typeof args.budget !== 'object' || args.budget === null || Array.isArray(args.budget)) {
        return this.createErrorResponse('budget must be an object', ['Check budget'], { code: 'INVALID_ARGUMENT' });
      }
      for (const [key, value] of Object.entries(args.budget as Record<string, unknown>)) {
        if (!budgetKeys[key]) {
          return this.createErrorResponse(`budget accepts ${Object.keys(budgetKeys).join(', ')}; not ${key}`, ['Check budget'], { code: 'INVALID_ARGUMENT' });
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          return this.createErrorResponse(`budget.${key} must be a number, 0 or more`, ['Check budget'], { code: 'INVALID_ARGUMENT' });
        }
        budget[key] = value;
      }
    }
    const seconds: number = args.seconds ?? 3;
    const warmup: number = args.warmup ?? 1;
    const tempDir = mkdtempSync(join(tmpdir(), 'godot-mcp-perf-'));
    try {
      const outFile = join(tempDir, 'perf.json');
      const ran = await this.runWindowedScript(
        this.profileScenePath, target.projectRoot,
        [`res://${args.scenePath}`, outFile, String(args.width ?? 1280), String(args.height ?? 720), String(warmup), String(seconds)],
        (seconds + warmup + 60) * 1000
      );
      if ('error' in ran) {
        return ran.error;
      }
      const result = this.readJsonFile(outFile);
      if (!result) {
        const reason = ran.output.split(/\r?\n/).find((line) => line.startsWith('PROFILE_FAIL')) ?? ran.output.trim().split(/\r?\n/).slice(-3).join('\n');
        return this.createErrorResponse(`Godot did not measure the scene: ${reason || 'no output'}`, ['This tool needs a display and a graphics driver; it cannot run headless or without a display']);
      }
      const violations = Object.entries(budget).flatMap(([key, limit]) => {
        const [metric, kind] = budgetKeys[key];
        const actual = result[metric] as number;
        const broken = kind === 'max' ? actual > limit : actual < limit;
        return broken ? [{ limit: key, metric, actual, allowed: limit, message: `${metric} is ${actual}, ${kind === 'max' ? 'above' : 'below'} the limit of ${limit}` }] : [];
      });
      const summary = [
        `${args.scenePath}: ${result.fps} fps over ${result.frames} frames at ${result.size.join('x')}. Frame time ${result.frame_ms_avg} ms average, ${result.frame_ms_p95} ms p95, ${result.frame_ms_max} ms worst.`,
        `Draw calls up to ${result.draw_calls_max}, ${result.nodes_max} nodes, ${result.memory_mb} MB memory, ${result.video_memory_mb} MB video memory.`,
        ...(Object.keys(budget).length > 0 ? [violations.length === 0 ? 'Within the budget.' : `Over the budget: ${violations.map((v) => v.message).join('; ')}.`] : []),
      ].join('\n');
      return this.textResult(summary, { ...result, budget, violations }, violations.length > 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** Handle the generate_tests tool */
  private async handleGenerateTests(rawArgs: any) {
    const args = this.normalizeParameters(rawArgs ?? {});
    const target = this.checkProjectFolder(args);
    if ('error' in target) {
      return target.error;
    }
    if (typeof args.scriptPath !== 'string' || !args.scriptPath.endsWith('.gd')) {
      return this.createErrorResponse('scriptPath must be a .gd file relative to the project', ['Check scriptPath'], { code: 'INVALID_ARGUMENT' });
    }
    if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
      return this.createErrorResponse('overwrite must be true or false', ['Check overwrite'], { code: 'INVALID_ARGUMENT' });
    }
    const script = this.resolveInsideProject(args.projectPath, args.scriptPath);
    if ('error' in script || !existsSync(join(target.projectRoot, script.relPath))) {
      return this.createErrorResponse(`Script not found: ${args.scriptPath}`, ['Check the path relative to the project'], { code: 'INVALID_PATH' });
    }
    const testDir = this.resolveInsideProject(args.projectPath, args.testDir ?? 'test/unit');
    if ('error' in testDir) {
      return this.createErrorResponse(`testDir: ${testDir.error}`, ['Use a folder inside the project'], { code: 'INVALID_PATH' });
    }
    const testRel = `${testDir.relPath}/test_${basename(script.relPath)}`;
    const testFile = join(target.projectRoot, testRel);
    if (existsSync(testFile) && args.overwrite !== true) {
      return this.createErrorResponse(`${testRel} already exists`, ['Pass overwrite to replace it, or choose another testDir'], { code: 'INVALID_ARGUMENT' });
    }
    try {
      const parsed = parseScript(readFileSync(join(target.projectRoot, script.relPath), 'utf8'));
      let checkpoint: string | undefined;
      if (existsSync(testFile)) {
        checkpoint = createCheckpoint(target.projectRoot, { label: `before replacing ${testRel}`, paths: [testRel] }).id;
      }
      mkdirSync(dirname(testFile), { recursive: true });
      writeFileSync(testFile, buildGutTest(script.relPath, parsed));
      const publicFunctions = parsed.functions.filter((f) => !f.name.startsWith('_'));
      const hasGut = existsSync(join(target.projectRoot, 'addons', 'gut'));
      return this.textResult(
        [
          `Wrote ${testRel}: ${publicFunctions.length} pending test(s) for functions, ${parsed.signals.length} signal check(s).`,
          ...(hasGut ? [] : ['GUT is not installed in addons/gut, which run_tests needs.']),
          ...(checkpoint ? [`The earlier file was saved in checkpoint ${checkpoint}.`] : []),
        ].join('\n'),
        { test: testRel, functions: publicFunctions.map((f) => f.name), signals: parsed.signals, gutInstalled: hasGut, checkpoint }
      );
    } catch (error: any) {
      return this.createErrorResponse(`Failed to write the test: ${error?.message || 'Unknown error'}`, ['Check that the project folder is writable']);
    }
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
        const projectFileContent = readFileSync(projectFile, 'utf8');
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
        // The operation script already words its failures as "Failed to add node: ...".
        return this.createErrorResponse(
          stderr.includes('Failed to add node') ? stderr : `Failed to add node: ${stderr}`,
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
            // The script prints a JSON line after its log lines; show that line when there is one.
            text: `UID for ${args.filePath}: ${(stdout.split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{')) ?? stdout).trim()}`,
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
      // No project_path parameter: the script scans res://, which is the project being opened.
      // An absolute path here would be read as a folder inside the project and find nothing.
      const { stdout, stderr } = await this.executeOperation('resave_resources', { all: true }, args.projectPath);

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
