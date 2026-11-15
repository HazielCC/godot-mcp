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
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
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
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: any = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
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
          description: 'Get the current debug output and errors. Also returns script errors (file, line, message, count) parsed from Godot output, with repeated errors grouped.',
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
          description: 'Check one GDScript file for syntax and parse errors without running the project. Returns each error with its file and line. Does not detect errors that depend on classes defined in other files.',
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
          description: 'Check every GDScript file in a Godot project for parse errors without running it. Starts one Godot process per file, so it can be slow on large projects. Does not detect errors that depend on classes defined in other files.',
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
          description: 'Run the project GUT tests headless and return structured results: totals, each failing test with its message, and script errors. Imports the project first unless importFirst is false. The call waits until the run finishes, which can take minutes on large suites.',
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
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
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
        case 'read_scene':
          return await this.handleReadScene(request.params.arguments);
        case 'set_node_property':
          return await this.handleSetNodeProperty(request.params.arguments);
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
      if (/^\s*(?:SCRIPT )?ERROR: /.test(buffer[i])) {
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
   * Run `godot --check-only` on one script.
   * executeOperation ignores the exit code, so this calls execFileAsync directly.
   */
  private async runCheckOnly(
    projectPath: string,
    resScriptPath: string
  ): Promise<{
    ok: boolean;
    errors: { file: string; line: number; message: string }[];
    rawOutput: string;
    // Set when Godot could not be started at all (for example, a wrong GODOT_PATH).
    executionError?: string;
  }> {
    let output = '';
    let exitCode = 0;
    try {
      const { stdout, stderr } = await execFileAsync(this.godotPath!, [
        '--headless',
        '--path',
        projectPath,
        '--check-only',
        '--script',
        resScriptPath,
      ]);
      output = `${stdout ?? ''}\n${stderr ?? ''}`;
    } catch (error: any) {
      // A numeric code is Godot's exit status. A string code (such as ENOENT) means
      // the executable could not be started, so there is no script result to report.
      if (typeof error?.code !== 'number') {
        return {
          ok: false,
          errors: [],
          rawOutput: '',
          executionError: error?.message || 'Unknown error starting Godot',
        };
      }
      exitCode = error.code;
      output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    }

    const errors = this.parseScriptErrors(output);
    return {
      ok: exitCode === 0 && errors.length === 0,
      errors,
      rawOutput: output.trim(),
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
   * Recursively list .gd files relative to rootDir.
   * Skips hidden entries such as .godot/ and .git/.
   */
  private findGdScripts(dir: string, rootDir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.findGdScripts(fullPath, rootDir, found);
      } else if (entry.isFile() && entry.name.endsWith('.gd')) {
        found.push(relative(rootDir, fullPath).replace(/\\/g, '/'));
      }
    }
    return found;
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

      const scripts = this.findGdScripts(projectRoot, projectRoot);
      if (scripts.length === 0) {
        return {
          content: [{ type: 'text', text: 'No GDScript files found in the project.' }],
        };
      }

      const failures: { script: string; errors: { file: string; line: number; message: string }[]; rawOutput: string }[] = [];
      for (const script of scripts) {
        const result = await this.runCheckOnly(projectRoot, `res://${script}`);
        if (result.executionError) {
          // Godot did not start, so every remaining file would fail the same way.
          return this.createErrorResponse(
            `Failed to run Godot: ${result.executionError}`,
            [
              'Set GODOT_PATH to the full path of a Godot executable',
              'Check that Godot runs from a terminal with --version',
            ]
          );
        }
        if (!result.ok) {
          failures.push({ script, errors: result.errors, rawOutput: result.rawOutput });
        }
      }

      if (failures.length === 0) {
        return {
          content: [{ type: 'text', text: `OK: checked ${scripts.length} GDScript files, no parse errors.` }],
        };
      }

      const details = failures
        .map((f) => this.formatCheckFailure(f.script, f))
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: `Checked ${scripts.length} GDScript files: ${failures.length} with errors.\n\n${details}`,
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

  /**
   * Handle the run_tests tool: run the GUT tests and return structured results.
   */
  private async handleRunTests(args: any) {
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

    for (const key of ['directory', 'select', 'testName']) {
      if (args[key] !== undefined && typeof args[key] !== 'string') {
        return this.createErrorResponse(`${key} must be text`, ['Provide it as a string']);
      }
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

    const directory = String(args.directory ?? 'res://test').replace(/\\/g, '/');
    if (!directory.startsWith('res://') || directory.includes('..')) {
      return this.createErrorResponse(
        `Invalid test directory: ${directory}`,
        ['Use a res:// path such as res://test']
      );
    }
    const directoryOnDisk = join(projectRoot, directory.slice('res://'.length));
    if (!existsSync(directoryOnDisk) || !statSync(directoryOnDisk).isDirectory()) {
      return this.createErrorResponse(
        `Test directory not found: ${directory}`,
        ['Check the directory relative to the project root']
      );
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
            ]
          );
        }
      }

      if (args.importFirst !== false) {
        const importOutput = await this.runGodotImport(projectRoot);
        if (importOutput !== undefined) {
          return this.createErrorResponse(
            `Godot import failed:\n${importOutput.slice(0, 1500)}`,
            ['Open the project in the Godot editor to see the import errors', 'Run again with importFirst set to false if the project is already imported']
          );
        }
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
          ['Increase timeoutMs, or narrow the run with select or testName']
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
          ]
        );
      }

      const parsed = this.parseJunitXml(run.junitXml);
      if (parsed.tests.length === 0) {
        return this.createErrorResponse(
          'No tests were run',
          ['Check that the test directory contains GUT test scripts (test_*.gd)', 'Check the select and testName filters']
        );
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

    return { format, root, nodeCount: nodes.length, extResources, subResources, orphanNodes };
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

    const parsed = this.parseSceneText(readFileSync(sceneFile, 'utf8'));
    if (!parsed.root) {
      return this.createErrorResponse(
        `No root node found in ${args.scenePath}`,
        ['The file may be empty or not a Godot scene']
      );
    }

    // A readable outline first, then the full structure for programmatic use.
    const outline: string[] = [];
    const walk = (node: SceneNodeInfo, depth: number) => {
      outline.push(`${'  '.repeat(depth)}- ${node.name} (${node.type ?? (node.instance ? 'instance' : 'unknown')}) ${node.path}`);
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    walk(parsed.root, 0);

    const summary = [
      `Scene ${args.scenePath}: ${parsed.nodeCount} nodes, ${parsed.extResources.length} external resources, ${parsed.subResources.length} sub-resources`,
      ...outline,
    ];
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
