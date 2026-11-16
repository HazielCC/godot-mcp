# Godot MCP

[![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) server that lets AI assistants open, run, and inspect your **Godot** projects, and edit their scenes.

> **Fork note:** This is a maintained fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) by Solomon Elias (MIT License). It is maintained independently at [HazielCC/godot-mcp](https://github.com/HazielCC/godot-mcp), and the install commands below point here.

## Why use it

With Godot MCP, your AI assistant can:

- Launch the Godot editor and run your project
- Read the debug output and errors, so it can see what went wrong
- Create scenes, add nodes, and load sprites
- Check the Godot version and the structure of your project

The result is a feedback loop: the assistant writes code, runs the game, reads the errors, and fixes them.

## Requirements

- [Godot Engine](https://godotengine.org/download) installed
- [Node.js](https://nodejs.org/en/download/) 18 or newer, with npm
- An AI assistant that supports MCP (Claude Code, Cline, Cursor, and others)

## Quick start

### Claude Code

Run this in a terminal:

```bash
claude mcp add godot -- npx -y github:HazielCC/godot-mcp
```

Restart Claude Code, and the Godot tools will be available.

To set the Godot path and turn on debug logs:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- npx -y github:HazielCC/godot-mcp
```

### Other clients

<details>
<summary><strong>Cline</strong></summary>

Add this to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "github:HazielCC/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "get_debug_output",
        "stop_project",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids"
      ]
    }
  }
}
```

The `autoApprove` list lets Cline run these tools without asking each time. Remove any you want to confirm manually.

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Open **Cursor Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Fill in the form:
   - Name: `godot`
   - Type: `command`
   - Command: `npx -y github:HazielCC/godot-mcp`
4. Click **Add**.
5. If the tool list is empty, press the refresh button on the server card.

**Using a project configuration:**

Create `.cursor/mcp.json` in your project folder:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "github:HazielCC/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Any other MCP client</strong></summary>

Use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "github:HazielCC/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

## Configuration

| Variable | What it does |
|----------|--------------|
| `GODOT_PATH` | Path to the Godot executable. Use it if automatic detection fails. |
| `DEBUG` | Set to `"true"` to show detailed server logs. |

## Tools

| Tool | What it does |
|------|--------------|
| `launch_editor` | Opens the Godot editor for a project |
| `run_project` | Runs a project in debug mode |
| `stop_project` | Stops the running project |
| `get_debug_output` | Returns the console output and errors, plus script errors with file, line, and message (repeated errors are grouped with a count) |
| `get_godot_version` | Returns the installed Godot version |
| `list_projects` | Finds Godot projects in a folder |
| `get_project_info` | Describes a project's structure |
| `create_scene` | Creates a new scene with a root node type |
| `add_node` | Adds a node to a scene, with properties |
| `load_sprite` | Loads a texture into a Sprite2D node |
| `export_mesh_library` | Exports 3D scenes as a MeshLibrary for GridMap |
| `save_scene` | Saves a scene, optionally as a variant |
| `get_uid` | Returns the UID of a file (Godot 4.4+) |
| `update_project_uids` | Updates UID references by resaving resources (Godot 4.4+) |
| `check_script` | Checks one `.gd` file for syntax errors without running the project, with file and line |
| `check_project_scripts` | Checks every `.gd` file in a project for parse and compile errors, with the autoloads registered. One Godot process checks the whole project |
| `run_tests` | Runs the GUT tests headless and returns totals, each failing test with its message, and script errors. Options: `directory`, `select` (script file name), `testName`, `importFirst`, `timeoutMs`, `rerunFailed` (reruns only the files that failed in the last full run, which is saved in `.godot/mcp_tests_last.json`), `junitPath` (writes a JUnit XML file inside the project for CI) |
| `diagnose_project` | Checks the Godot executable and version, the project file, the import cache, importable assets without a `.import` file, and `.import` files with missing outputs. Option: `runImport` |
| `read_scene` | Reads a `.tscn` scene as a node tree, with each node's type, path (such as `root/Player`), and properties |
| `set_node_property` | Sets one property on a node of an existing scene and saves it. The value is a Godot literal, such as `Vector2(1, 2)` |
| `install_editor_bridge` | Installs the Godot MCP Bridge plugin in a project and enables it, so the server can drive the project while the editor has it open |
| `editor_status` | Checks whether the project is open in the editor with the bridge enabled, and reports the open scene and whether it is playing |
| `editor_command` | Runs one command in the open editor: scene tree, open or save a scene, get or set a property (with undo), add a node, undo, redo, play, stop |
| `verify_game` | Plays a scene with a probe, checks that the frame counter keeps advancing, takes a screenshot, lists the runtime errors and stops the game. Needs the editor open with the bridge |

## Building from source

Use this if you want to modify the server or run a local copy:

```bash
git clone https://github.com/HazielCC/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Then point your MCP client to `build/index.js` instead of using `npx`.

## How it works

- **Simple operations** (launching the editor, running a project, reading the version) call Godot's command-line interface directly.
- **Complex operations** (creating scenes, adding nodes, exporting meshes) run through one GDScript file, `godot_operations.gd`. The server sends it the operation and its parameters as JSON, so it doesn't need to create a temporary script for each operation.

## Troubleshooting

- **Godot not found:** Set `GODOT_PATH` to the full path of your Godot executable.
- **The tools don't appear:** Make sure the server is enabled in your client, then restart the assistant.
- **"Invalid project path":** The folder must contain a `project.godot` file.
- **Build errors:** Run `npm install` again, then `npm run build`.

<details>
<summary><strong>Cursor-specific issues</strong></summary>

- Check that the server is enabled in **Settings** > **MCP**.
- MCP tools only run in the Agent chat mode (available with Cursor Pro or Business).
- Enable "Yolo Mode" if you want tool requests to run without confirmation.

</details>

## Credits and license

Godot MCP was created by Solomon Elias ([Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)). This fork keeps the original MIT License. See [LICENSE](LICENSE) for details.
