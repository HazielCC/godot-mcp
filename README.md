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
| `GODOT_MCP_DEBUG` | Set to `"true"` to make the scene operations print everything they do (and write test files in the project). Off by default. |

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

### 2D tools

These need Godot 4.3 or later. Scenes that inherit from another scene are not edited by them: run them on the base scene.

| Tool | What it does |
|------|--------------|
| `import_spritesheet` | Cuts a sprite sheet (`frameWidth`/`frameHeight`, or `columns`/`rows`) into a `SpriteFrames` resource with named animations (`row`, or `start` and `count`, plus `fps` and `loop`). With `scenePath` it also adds an `AnimatedSprite2D` that uses it |
| `auto_collision` | Builds `CollisionPolygon2D` (or `LightOccluder2D` with `kind: "occluder"`) from the opaque pixels of a `Sprite2D`. Takes the region and the current frame of a sprite sheet into account. Options: `epsilon`, `minArea`, `alphaThreshold`, `replace` |
| `build_tilemap` | Paints a `TileMapLayer` from rows of text, with a `legend` that maps each character to a cell of the tile atlas. Creates the `TileSet` from a texture when it does not exist |
| `setup_parallax_2d` | Adds `Parallax2D` background layers, each with its texture, scroll scale and optional horizontal repeat |
| `render_scene_2d` | Draws a scene and returns a PNG, to check how it looks. It opens a short-lived Godot window, so it needs a display and a graphics driver; it does not work headless |

To try them, run `node scripts/fixtures/make-2d-fixture.mjs`. It writes a small project with a sprite sheet, a tile atlas and a scene, and prints its path.

### 3D tools

These need Godot 4.3 or later. Like the 2D tools, they do not edit scenes that inherit from another scene.

| Tool | What it does |
|------|--------------|
| `build_blockout` | Builds a greybox level from rows of text. Each character has a height, elevation, color and collision flag; runs of equal characters become one box (a `StaticBody3D` with a mesh and a `BoxShape3D`) |
| `create_pbr_material` | Creates a `StandardMaterial3D` from a folder of textures, matching files by name (albedo, normal, roughness, metallic, ao, orm, emission, height). Can assign it to a node. The textures must be imported |
| `scatter_multimesh` | Spreads copies of a mesh (a `.tres`/`.obj`, the first mesh of a `.glb`/`.gltf`/`.tscn` saved as a `.res`, or a primitive) at random over a rectangle in a `MultiMeshInstance3D`. The same `seed` gives the same layout |
| `bake_navmesh` | Bakes a navigation mesh from the meshes and static colliders of a scene into a `NavigationRegion3D`. Geometry is read from a copy of the scene with its scripts removed, so their `_ready` does not run (`runScripts: true` keeps them) |
| `render_scene_3d` | Draws a scene from `iso`, `front`, `back`, `left`, `right` or `top` and returns one PNG per view. It frames the whole scene and adds a sun and an environment when it has none. It needs a display and a graphics driver; it does not work headless |

**MultiMesh data.** Godot in headless mode has no rendering server, so it cannot store a `MultiMesh`'s instances: `scatter_multimesh` writes the scene file itself, and the other tools (and `update_project_uids`) put the data back after they re-save a scene with Godot, so scattered instances are not lost whatever the order of the tools.

To try them, run `node scripts/fixtures/make-3d-fixture.mjs`. It writes a small project with a brick texture folder, a crate model and a scene with a floor, and prints its path.

### UI tools

These need Godot 4.3 or later. `build_ui` and `make_theme` work headless. The four tools that draw or measure (`render_scene_ui`, `ui_lint`, `ui_check_focus`, `ui_check_contrast`) open a short-lived Godot window, so they need a display and a graphics driver; each screen size is drawn in its own `SubViewport`, so a size larger than your screen works.

| Tool | What it does |
|------|--------------|
| `build_ui` | Builds a tree of `Control` nodes from a JSON spec, `{type, name, props, children}`, and adds it to a scene (or creates the scene). Besides any property of the node, `props` has shortcuts: `anchors` (a preset such as `full_rect` or `center`), `margins`, `separation`, `size_flags_horizontal`/`size_flags_vertical`, `theme_constants`, `theme_colors`, `theme_font_sizes`. Enum names, `"#rrggbb"` colors and `[x, y]` vectors are accepted, and every value is read back to check it took |
| `make_theme` | Creates a `Theme` (`.tres`) from a palette: button states, the variations `PrimaryButton`, `AccentButton` and `DangerButton`, panels, labels, text fields, check boxes and progress bars. Text colors are picked for contrast. Can set it on a node |
| `render_scene_ui` | Draws a scene at several sizes (`small`, `phone`, `tablet`, `hd`, `fhd`, `4k` or `WIDTHxHEIGHT`) and returns one PNG per size |
| `ui_lint` | Finds layout problems per size: controls outside or sticking out of the screen, text cut off, controls that overflow their parent, touch targets under 44 px, panels that block clicks on a button, overlapping labels. Each problem has the node path, a severity and a suggestion. `pseudoLocalize` makes the texts about 40 % longer to test other languages |
| `ui_check_focus` | Checks keyboard and gamepad use: lists the focusable controls, follows the arrow keys and Tab from the first one, and reports unreachable controls, dead ends, focus neighbors that do not exist, an empty focus style and a screen that opens without focus |
| `ui_check_contrast` | Measures the contrast of every text against the background that is actually drawn behind it (WCAG 4.5:1, or 3:1 for large text) and suggests a color that passes |

To try them, run `node scripts/fixtures/make-ui-fixture.mjs`. It writes a project with a menu that has defects on purpose (`scenes/broken.tscn`), and prints its path.

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
