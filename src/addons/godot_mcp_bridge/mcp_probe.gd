extends Node

# Runs inside the game that the editor bridge starts in probe mode (play with mode "probe").
# The bridge puts this node in a small wrapper scene, so the project and its autoloads are
# not changed. Every WRITE_INTERVAL seconds the node writes its state to
# res://.godot/mcp_probe/status.json: frame count, elapsed time, whether the target scene was
# added, the screenshot result and the errors Godot reported. A screenshot is taken when
# request.json asks for one, after the frame has been drawn. If the game freezes, the status
# file stops changing, and that is how the bridge sees it.

const PROBE_DIR: String = "res://.godot/mcp_probe"
const STATUS_PATH: String = "res://.godot/mcp_probe/status.json"
const REQUEST_PATH: String = "res://.godot/mcp_probe/request.json"
const WRITE_INTERVAL: float = 0.2

## Scene the game runs, set by the wrapper scene.
@export var target_scene: String = ""
## Identifies this run; the bridge ignores status and requests that carry another session.
@export var session: String = ""

class ProbeLogger extends Logger:
    const MAX_ENTRIES: int = 200

    var _lock: Mutex = Mutex.new()
    var _entries: Array[Dictionary] = []
    var _error_count: int = 0
    # Called after each error, so the status reaches the disk before the debugger pauses the game.
    var on_error: Callable = Callable()

    func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
        var kind: String = "warning" if error_type == Logger.ERROR_TYPE_WARNING else "error"
        var text: String = rationale if rationale != "" else code
        _add(kind, text, file, line)

    func _log_message(message: String, error: bool) -> void:
        if error and message.strip_edges() != "":
            _add("stderr", message.strip_edges(), "", 0)

    func _add(kind: String, text: String, file: String, line: int) -> void:
        _lock.lock()
        if kind != "warning":
            _error_count += 1
        _entries.append({"kind": kind, "message": text, "file": file, "line": line})
        if _entries.size() > MAX_ENTRIES:
            _entries.pop_front()
        _lock.unlock()
        if kind != "warning" and on_error.is_valid():
            on_error.call()

    func snapshot() -> Dictionary:
        _lock.lock()
        var result: Dictionary = {"entries": _entries.duplicate(), "error_count": _error_count}
        _lock.unlock()
        return result

var _frames: int = 0
var _elapsed: float = 0.0
var _since_write: float = 0.0
var _attached: bool = false
var _load_error: String = ""
var _logger: ProbeLogger = null
var _capture_requested: bool = false
var _capture_request_id: String = ""
var _capture_id: String = ""
var _capture_path: String = ""
var _capture_error: String = ""
var _writing: bool = false

func _ready() -> void:
    DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(PROBE_DIR))
    _logger = ProbeLogger.new()
    _logger.on_error = _write_status
    OS.add_logger(_logger)
    RenderingServer.frame_post_draw.connect(_on_frame_post_draw)
    _write_status()
    _attach_target.call_deferred()

func _process(delta: float) -> void:
    _frames += 1
    _elapsed += delta
    _since_write += delta
    if _since_write < WRITE_INTERVAL:
        return
    _since_write = 0.0
    _read_request()
    _write_status()

func _attach_target() -> void:
    if target_scene == "":
        _load_error = "The probe has no target scene"
        return
    var packed: PackedScene = load(target_scene) as PackedScene
    if packed == null:
        _load_error = "Could not load the scene " + target_scene
        return
    var scene: Node = packed.instantiate()
    get_tree().root.add_child(scene)
    get_tree().current_scene = scene
    _attached = true
    _write_status()

func _read_request() -> void:
    if _capture_requested or not FileAccess.file_exists(REQUEST_PATH):
        return
    # A request that is still being written does not parse yet; try again on the next write.
    var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(REQUEST_PATH))
    if typeof(parsed) != TYPE_DICTIONARY:
        return
    var request: Dictionary = parsed
    if str(request.get("session", "")) != session:
        return
    DirAccess.remove_absolute(ProjectSettings.globalize_path(REQUEST_PATH))
    if not bool(request.get("capture", false)):
        return
    _capture_request_id = str(request.get("id", str(_frames)))
    _capture_requested = true

func _on_frame_post_draw() -> void:
    if not _capture_requested:
        return
    _capture_requested = false
    _capture_id = _capture_request_id
    var image: Image = get_viewport().get_texture().get_image()
    if image == null:
        _capture_error = "The viewport has no image"
        return
    var global_path: String = ProjectSettings.globalize_path("%s/capture_%s.png" % [PROBE_DIR, _capture_id])
    var error: Error = image.save_png(global_path)
    if error != OK:
        _capture_error = "Could not save the screenshot: error %d" % error
        return
    _capture_path = global_path
    _capture_error = ""

func _write_status() -> void:
    # Writing can itself report an error, which would call back here; skip that nested write.
    if _writing:
        return
    _writing = true
    var snapshot: Dictionary = _logger.snapshot()
    var status: Dictionary = {
        "protocol": 1,
        "pid": OS.get_process_id(),
        "target": target_scene,
        "session": session,
        "attached": _attached,
        "load_error": _load_error,
        "frames": _frames,
        "elapsed": _elapsed,
        "error_count": snapshot.get("error_count", 0),
        "errors": snapshot.get("entries", []),
        "capture_id": _capture_id,
        "capture_path": _capture_path,
        "capture_error": _capture_error,
    }
    var file: FileAccess = FileAccess.open(STATUS_PATH, FileAccess.WRITE)
    if file != null:
        file.store_string(JSON.stringify(status, "  "))
        file.close()
    _writing = false
