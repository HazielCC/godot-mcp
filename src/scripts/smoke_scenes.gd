#!/usr/bin/env -S godot --headless --script smoke_scenes.gd
extends SceneTree

# Opens every scene of a list, lets it run for some frames, and records the errors Godot reports while it
# does, scene by scene. Runs headless.
#
# Usage: godot --headless --path <project> --script smoke_scenes.gd -- <list.json> <out.json> <frames>
#   list.json: a JSON list of res:// scene paths
# Writes <out.json> after every scene, so a result survives a crash, and <out.json>.current with the scene that
# is running, so a scene that hangs can be named. Prints "SMOKE_DONE" at the end.

class SmokeLogger extends Logger:
    var _lock: Mutex = Mutex.new()
    var _entries: Array = []

    func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
        var kind: String = "error"
        if error_type == Logger.ERROR_TYPE_WARNING:
            kind = "warning"
        elif error_type == Logger.ERROR_TYPE_SCRIPT:
            kind = "script"
        _lock.lock()
        _entries.append({"kind": kind, "message": rationale if rationale != "" else code, "file": file, "line": line})
        _lock.unlock()

    func take() -> Array:
        _lock.lock()
        var copy: Array = _entries.duplicate()
        _entries.clear()
        _lock.unlock()
        return copy

var _out_path: String = ""
var _results: Array = []

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 3:
        print("SMOKE_FAIL usage: <list.json> <out.json> <frames>")
        quit(1)
        return
    _out_path = args[1]
    _run.call_deferred(args[0], int(args[2]))

func _count_nodes(node: Node) -> int:
    var total: int = 1
    for child: Node in node.get_children():
        total += _count_nodes(child)
    return total

func _write() -> void:
    var file: FileAccess = FileAccess.open(_out_path, FileAccess.WRITE)
    if file != null:
        file.store_string(JSON.stringify({"scenes": _results}))
        file.close()

func _run(list_path: String, frames: int) -> void:
    var scenes: Array = JSON.parse_string(FileAccess.get_file_as_string(list_path)) as Array
    var logger: SmokeLogger = SmokeLogger.new()
    OS.add_logger(logger)
    for entry: Variant in scenes:
        var path: String = str(entry)
        var current: FileAccess = FileAccess.open(_out_path + ".current", FileAccess.WRITE)
        if current != null:
            current.store_string(path)
            current.close()
        logger.take()
        var started: int = Time.get_ticks_msec()
        var record: Dictionary = {"scene": path, "load_error": "", "nodes": 0}
        var packed: PackedScene = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_REPLACE) as PackedScene
        var instance: Node = null
        if packed == null:
            record["load_error"] = "Godot could not load the scene"
        else:
            instance = packed.instantiate()
            if instance == null:
                record["load_error"] = "The scene could not be instantiated"
        if instance != null:
            root.add_child(instance)
            record["nodes"] = _count_nodes(instance)
            for i: int in range(frames):
                await process_frame
            if is_instance_valid(instance):
                instance.queue_free()
            await process_frame
        var entries: Array = logger.take()
        var errors: Array = []
        var warnings: int = 0
        for item: Dictionary in entries:
            if str(item.kind) == "warning":
                warnings += 1
            else:
                errors.append(item)
        record["errors"] = errors.slice(0, 20)
        record["error_count"] = errors.size()
        record["warnings"] = warnings
        record["ms"] = Time.get_ticks_msec() - started
        record["ok"] = record.load_error == "" and errors.is_empty()
        _results.append(record)
        _write()
    DirAccess.remove_absolute(_out_path + ".current")
    print("SMOKE_DONE")
    quit()
