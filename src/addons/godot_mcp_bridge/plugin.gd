@tool
extends EditorPlugin

# Local bridge between the godot-mcp server and this editor.
#
# It listens on 127.0.0.1 only. Each request is one JSON object per line:
#   {"id": 1, "token": "...", "command": "status", "arguments": {}}
# and each answer is one JSON object per line:
#   {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "..."}
#
# Every request must carry the token written to .godot/mcp_bridge.json. Only the commands
# listed in _run_command are accepted. There is no code evaluation.

const INFO_PATH: String = "res://.godot/mcp_bridge.json"
const PORT_FIRST: int = 47800
const PORT_LAST: int = 47899
const MAX_LINE_BYTES: int = 1048576
const MAX_TREE_NODES: int = 500

var _server: TCPServer = null
var _clients: Array[StreamPeerTCP] = []
var _buffers: Dictionary = {}
var _token: String = ""
var _port: int = 0
var _tree_count: int = 0
var _handling: bool = false

func _enter_tree() -> void:
    var crypto: Crypto = Crypto.new()
    _token = crypto.generate_random_bytes(24).hex_encode()

    _server = TCPServer.new()
    for candidate: int in range(PORT_FIRST, PORT_LAST + 1):
        if _server.listen(candidate, "127.0.0.1") == OK:
            _port = candidate
            break
    if _port == 0:
        push_error("Godot MCP Bridge: no free port between %d and %d" % [PORT_FIRST, PORT_LAST])
        return

    _write_info()
    set_process(true)
    print("Godot MCP Bridge listening on 127.0.0.1:%d" % _port)

func _exit_tree() -> void:
    set_process(false)
    for client: StreamPeerTCP in _clients:
        client.disconnect_from_host()
    _clients.clear()
    _buffers.clear()
    if _server != null:
        _server.stop()
        _server = null
    _remove_info()

func _process(_delta: float) -> void:
    # Saving and playing run the editor's main loop again, which calls this function from
    # inside a request. Serving clients then would handle the same request again, so skip it.
    if _handling:
        return
    _handling = true
    _serve_clients()
    _handling = false

func _serve_clients() -> void:
    if _server == null or not _server.is_listening():
        return

    while _server.is_connection_available():
        var connection: StreamPeerTCP = _server.take_connection()
        if connection != null:
            _clients.append(connection)
            _buffers[connection] = ""

    for client: StreamPeerTCP in _clients.duplicate():
        client.poll()
        if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
            _forget(client)
            continue

        var available: int = client.get_available_bytes()
        if available > 0:
            var chunk: String = client.get_utf8_string(available)
            _buffers[client] = str(_buffers[client]) + chunk

        var buffered: String = str(_buffers[client])
        if buffered.length() > MAX_LINE_BYTES:
            _forget(client)
            continue

        var newline: int = buffered.find("\n")
        while newline != -1:
            var line: String = buffered.substr(0, newline).strip_edges()
            buffered = buffered.substr(newline + 1)
            _buffers[client] = buffered
            if line != "":
                var answer: Dictionary = _handle_line(line)
                client.put_data((JSON.stringify(answer) + "\n").to_utf8_buffer())
            newline = buffered.find("\n")

func _forget(client: StreamPeerTCP) -> void:
    _clients.erase(client)
    _buffers.erase(client)

func _handle_line(line: String) -> Dictionary:
    var parsed: Variant = JSON.parse_string(line)
    if typeof(parsed) != TYPE_DICTIONARY:
        return {"ok": false, "error": "A request must be a JSON object"}

    var request: Dictionary = parsed
    var request_id: Variant = request.get("id", null)
    if str(request.get("token", "")) != _token:
        return {"id": request_id, "ok": false, "error": "Invalid token"}

    var arguments_value: Variant = request.get("arguments", {})
    var arguments: Dictionary = arguments_value if typeof(arguments_value) == TYPE_DICTIONARY else {}
    var answer: Dictionary = _run_command(str(request.get("command", "")), arguments)
    answer["id"] = request_id
    return answer

func _run_command(command: String, arguments: Dictionary) -> Dictionary:
    match command:
        "status":
            return _ok(_status())
        "scene_tree":
            return _scene_tree()
        "open_scene":
            return _open_scene(arguments)
        "save_scene":
            return _save_scene()
        "get_property":
            return _get_property(arguments)
        "set_property":
            return _set_property(arguments)
        "add_node":
            return _add_node(arguments)
        "undo":
            return _undo_or_redo(true)
        "redo":
            return _undo_or_redo(false)
        "play":
            return _play(arguments)
        "stop":
            EditorInterface.stop_playing_scene()
            return _ok({"stopped": true})
        "refresh_filesystem":
            EditorInterface.get_resource_filesystem().scan()
            return _ok({"scanned": true})
        _:
            return _error("Unknown command: " + command)

# ---------------------------------------------------------------- commands

func _status() -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    return {
        "protocol": 1,
        "editor_version": Engine.get_version_info().get("string", ""),
        "project_name": str(ProjectSettings.get_setting("application/config/name", "")),
        "edited_scene": root.scene_file_path if root != null else "",
        "playing": EditorInterface.is_playing_scene(),
    }

func _scene_tree() -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    if root == null:
        return _error("No scene is open in the editor")
    _tree_count = 0
    return _ok({"tree": _node_info(root, root)})

func _open_scene(arguments: Dictionary) -> Dictionary:
    var path: String = str(arguments.get("path", ""))
    if not _is_project_path(path, ".tscn"):
        return _error("path must be a res:// .tscn path inside the project")
    if not FileAccess.file_exists(path):
        return _error("Scene not found: " + path)
    EditorInterface.open_scene_from_path(path)
    return _ok({"opened": path})

func _save_scene() -> Dictionary:
    var error: Error = EditorInterface.save_scene()
    if error != OK:
        return _error("Save failed with error %d" % error)
    return _ok({"saved": true})

func _get_property(arguments: Dictionary) -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    if root == null:
        return _error("No scene is open in the editor")
    var node: Node = _find_node(root, str(arguments.get("node_path", "")))
    if node == null:
        return _error("Node not found: " + str(arguments.get("node_path", "")))
    var property_name: String = str(arguments.get("property", ""))
    if not _has_property(node, property_name):
        return _error("Node has no property " + property_name)
    return _ok({"value": var_to_str(node.get(property_name))})

func _set_property(arguments: Dictionary) -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    if root == null:
        return _error("No scene is open in the editor")
    var node_path: String = str(arguments.get("node_path", ""))
    var node: Node = _find_node(root, node_path)
    if node == null:
        return _error("Node not found: " + node_path)
    var property_name: String = str(arguments.get("property", ""))
    if not _has_property(node, property_name):
        return _error("Node has no property " + property_name)
    var value_text: String = str(arguments.get("value", ""))
    var value: Variant = str_to_var(value_text)
    if value == null and value_text.strip_edges() != "null":
        return _error("value is not a valid Godot literal: " + value_text)

    var previous: Variant = node.get(property_name)
    var undo_redo: EditorUndoRedoManager = get_undo_redo()
    undo_redo.create_action("MCP: set " + property_name, UndoRedo.MERGE_DISABLE, root)
    undo_redo.add_do_property(node, property_name, value)
    undo_redo.add_undo_property(node, property_name, previous)
    undo_redo.commit_action()
    return _ok({"value": var_to_str(node.get(property_name))})

func _add_node(arguments: Dictionary) -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    if root == null:
        return _error("No scene is open in the editor")
    var parent: Node = _find_node(root, str(arguments.get("parent_path", root.name)))
    if parent == null:
        return _error("Parent node not found: " + str(arguments.get("parent_path", "")))
    var type_name: String = str(arguments.get("type", ""))
    if not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Node"):
        return _error("type must be a built-in Node class: " + type_name)
    var node_name: String = str(arguments.get("name", type_name))
    if node_name == "" or node_name.contains("/") or parent.get_node_or_null(node_name) != null:
        return _error("name is empty, contains '/', or is already used under the parent: " + node_name)

    var node: Node = ClassDB.instantiate(type_name) as Node
    if node == null:
        return _error("Could not instantiate " + type_name)
    node.name = node_name

    var undo_redo: EditorUndoRedoManager = get_undo_redo()
    undo_redo.create_action("MCP: add " + node_name, UndoRedo.MERGE_DISABLE, root)
    undo_redo.add_do_method(parent, "add_child", node)
    undo_redo.add_do_property(node, "owner", root)
    undo_redo.add_do_reference(node)
    undo_redo.add_undo_method(parent, "remove_child", node)
    undo_redo.commit_action()
    return _ok({"added": _path_of(root, node)})

func _undo_or_redo(undo: bool) -> Dictionary:
    var root: Node = EditorInterface.get_edited_scene_root()
    if root == null:
        return _error("No scene is open in the editor")
    var undo_redo: EditorUndoRedoManager = get_undo_redo()
    var history: UndoRedo = undo_redo.get_history_undo_redo(undo_redo.get_object_history_id(root))
    var done: bool = history.undo() if undo else history.redo()
    return _ok({"done": done})

func _play(arguments: Dictionary) -> Dictionary:
    var mode: String = str(arguments.get("mode", "main"))
    match mode:
        "main":
            if str(ProjectSettings.get_setting("application/run/main_scene", "")) == "":
                return _error("The project has no main scene set (application/run/main_scene)")
            EditorInterface.play_main_scene()
        "current":
            EditorInterface.play_current_scene()
        "custom":
            var path: String = str(arguments.get("path", ""))
            if not _is_project_path(path, ".tscn"):
                return _error("path must be a res:// .tscn path inside the project")
            EditorInterface.play_custom_scene(path)
        _:
            return _error("mode must be main, current or custom")
    return _ok({"playing": mode})

# ---------------------------------------------------------------- helpers

func _ok(result: Dictionary) -> Dictionary:
    return {"ok": true, "result": result}

func _error(message: String) -> Dictionary:
    return {"ok": false, "error": message}

func _is_project_path(path: String, extension: String) -> bool:
    return path.begins_with("res://") and not path.contains("..") and path.ends_with(extension)

func _has_property(node: Object, property_name: String) -> bool:
    for info: Dictionary in node.get_property_list():
        if str(info.get("name", "")) == property_name:
            return true
    return false

# Accepts "root", "root/Player" (the first segment is the scene root) or "Player".
func _find_node(root: Node, node_path: String) -> Node:
    if node_path == "" or node_path == root.name:
        return root
    var relative: String = node_path
    if node_path.begins_with(str(root.name) + "/"):
        relative = node_path.substr(str(root.name).length() + 1)
    return root.get_node_or_null(relative)

func _path_of(root: Node, node: Node) -> String:
    if node == root:
        return str(root.name)
    return str(root.name) + "/" + str(root.get_path_to(node))

func _node_info(root: Node, node: Node) -> Dictionary:
    _tree_count += 1
    var children: Array = []
    if _tree_count < MAX_TREE_NODES:
        for child: Node in node.get_children():
            if _tree_count >= MAX_TREE_NODES:
                break
            children.append(_node_info(root, child))
    return {
        "name": str(node.name),
        "type": node.get_class(),
        "path": _path_of(root, node),
        "children": children,
    }

func _write_info() -> void:
    var info: Dictionary = {
        "port": _port,
        "token": _token,
        "pid": OS.get_process_id(),
        "protocol": 1,
    }
    var file: FileAccess = FileAccess.open(INFO_PATH, FileAccess.WRITE)
    if file == null:
        push_error("Godot MCP Bridge: could not write " + INFO_PATH)
        return
    file.store_string(JSON.stringify(info, "  "))
    file.close()

func _remove_info() -> void:
    if FileAccess.file_exists(INFO_PATH):
        DirAccess.remove_absolute(ProjectSettings.globalize_path(INFO_PATH))
