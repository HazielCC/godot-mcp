#!/usr/bin/env -S godot --headless --script play_scenario.gd
extends SceneTree

# Plays a scene while it follows a scenario: waits, key and action presses, mouse clicks, property changes,
# method calls and checks on the properties of nodes. Runs headless.
#
# Usage: godot --headless --path <project> --script play_scenario.gd -- <scenario.json> <out.json>
# The scenario is {"scene": "res://x.tscn", "time_scale": 1, "continue_on_fail": false, "steps": [...]}.
# Steps (one key each, plus an optional "name"):
#   {"wait": 1.5}                          seconds of game time
#   {"frames": 10}                         frames
#   {"press": "ui_accept", "hold": 0.1}    an input action
#   {"key": "Space", "hold": 0.1}          a keyboard key
#   {"click": [100, 80], "button": "left"} a mouse click
#   {"set": {"node": "Main/Player", "property": "position", "value": "Vector2(10, 0)"}}
#   {"call": {"node": "Main/Player", "method": "jump", "args": [1]}}
#   {"assert": {"node": "Main/Player", "property": "position:x", "op": ">", "value": 5}}
#   {"wait_until": {"node": ..., "property": ..., "op": ..., "value": ..., "timeout": 5}}
#   {"assert_no_errors": true}
# Ops: == != < <= > >= approx contains exists visible.
# Writes the result to <out.json> and prints "SCENARIO_DONE".

class ScenarioLogger extends Logger:
    var _lock: Mutex = Mutex.new()
    var _entries: Array = []

    func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
        if error_type == Logger.ERROR_TYPE_WARNING:
            return
        _lock.lock()
        _entries.append({"message": rationale if rationale != "" else code, "file": file, "line": line})
        _lock.unlock()

    func snapshot() -> Array:
        _lock.lock()
        var copy: Array = _entries.duplicate()
        _lock.unlock()
        return copy

var _scene: Node = null
var _logger: ScenarioLogger = null
var _out_path: String = ""
var _results: Array = []

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 2:
        print("SCENARIO_FAIL usage: <scenario.json> <out.json>")
        quit(1)
        return
    _out_path = args[1]
    _run.call_deferred(args[0])

func _write(extra: Dictionary) -> void:
    var passed: int = 0
    var failed: int = 0
    for result: Dictionary in _results:
        if bool(result.ok):
            passed += 1
        else:
            failed += 1
    var data: Dictionary = {"results": _results, "passed": passed, "failed": failed, "errors": _logger.snapshot().slice(0, 30)}
    data.merge(extra)
    var file: FileAccess = FileAccess.open(_out_path, FileAccess.WRITE)
    if file != null:
        file.store_string(JSON.stringify(data))
        file.close()

func _run(scenario_path: String) -> void:
    _logger = ScenarioLogger.new()
    OS.add_logger(_logger)
    var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(scenario_path)) as Dictionary
    var packed: PackedScene = load(str(data.scene)) as PackedScene
    if packed == null:
        _write({"fatal": "Godot could not load " + str(data.scene)})
        print("SCENARIO_DONE")
        quit(1)
        return
    Engine.time_scale = float(data.get("time_scale", 1.0))
    _scene = packed.instantiate()
    root.add_child(_scene)
    current_scene = _scene
    for i: int in range(3):
        await process_frame

    var started: int = Time.get_ticks_msec()
    var continue_on_fail: bool = bool(data.get("continue_on_fail", false))
    var steps: Array = data.get("steps", []) as Array
    for index: int in range(steps.size()):
        var step: Dictionary = steps[index] as Dictionary
        var outcome: Dictionary = await _run_step(step)
        outcome["index"] = index
        outcome["name"] = str(step.get("name", ""))
        outcome["step"] = step
        _results.append(outcome)
        if not bool(outcome.ok) and not continue_on_fail:
            break
    Engine.time_scale = 1.0
    _write({"scene": str(data.scene), "steps_total": steps.size(), "elapsed_ms": Time.get_ticks_msec() - started})
    print("SCENARIO_DONE")
    quit()

func _ok(message: String = "", extra: Dictionary = {}) -> Dictionary:
    var result: Dictionary = {"ok": true, "message": message}
    result.merge(extra)
    return result

func _bad(message: String, extra: Dictionary = {}) -> Dictionary:
    var result: Dictionary = {"ok": false, "message": message}
    result.merge(extra)
    return result

# A node from a path that starts with the scene's root name, "." for the root, or an absolute /root/... path.
func _find(path: String) -> Node:
    if path.begins_with("/root"):
        return root.get_node_or_null(path.substr(6) if path.length() > 6 else ".")
    if path == "." or path == str(_scene.name):
        return _scene
    if path.begins_with(str(_scene.name) + "/"):
        return _scene.get_node_or_null(path.substr(str(_scene.name).length() + 1))
    return _scene.get_node_or_null(path)

# A text that is a Godot literal (10, Vector2(1, 2), "quoted text") becomes that value; other text stays text.
func _literal(value: Variant) -> Variant:
    if typeof(value) == TYPE_STRING:
        var text: String = str(value)
        var parsed: Variant = str_to_var(text)
        if parsed != null and (typeof(parsed) != TYPE_STRING or text.strip_edges().begins_with("\"")):
            return parsed
    return value

func _compare(actual: Variant, op: String, expected: Variant) -> bool:
    var wanted: Variant = _literal(expected)
    match op:
        "==":
            return _equal(actual, wanted)
        "!=":
            return not _equal(actual, wanted)
        "<":
            return float(actual) < float(wanted)
        "<=":
            return float(actual) <= float(wanted)
        ">":
            return float(actual) > float(wanted)
        ">=":
            return float(actual) >= float(wanted)
        "approx":
            if typeof(actual) == TYPE_VECTOR2:
                return (actual as Vector2).is_equal_approx(wanted as Vector2)
            if typeof(actual) == TYPE_VECTOR3:
                return (actual as Vector3).is_equal_approx(wanted as Vector3)
            return absf(float(actual) - float(wanted)) < 0.001
        "contains":
            if typeof(actual) == TYPE_STRING:
                return str(actual).contains(str(wanted))
            if typeof(actual) == TYPE_DICTIONARY:
                return (actual as Dictionary).has(wanted)
            if typeof(actual) == TYPE_ARRAY:
                return (actual as Array).has(wanted)
            return false
    return false

func _equal(actual: Variant, wanted: Variant) -> bool:
    var kinds: Array = [TYPE_INT, TYPE_FLOAT]
    if kinds.has(typeof(actual)) and kinds.has(typeof(wanted)):
        return absf(float(actual) - float(wanted)) < 0.00001
    if typeof(actual) == TYPE_STRING or typeof(actual) == TYPE_STRING_NAME:
        return str(actual) == str(wanted)
    return actual == wanted

# One check on a node: returns {ok, message, actual}.
func _check(spec: Dictionary) -> Dictionary:
    var node: Node = _find(str(spec.get("node", "")))
    var op: String = str(spec.get("op", "=="))
    if op == "exists":
        return _ok("", {"actual": node != null}) if node != null else _bad("Node not found: " + str(spec.get("node", "")), {"actual": false})
    if node == null:
        return _bad("Node not found: " + str(spec.get("node", "")))
    if op == "visible":
        var shown: bool = bool(node.get("visible")) if "visible" in node else false
        return _ok("", {"actual": shown}) if shown else _bad(str(spec.node) + " is not visible", {"actual": shown})
    var property_path: String = str(spec.get("property", ""))
    if property_path == "":
        return _bad("assert needs a property")
    var actual: Variant = node.get_indexed(NodePath(property_path))
    var shown_actual: String = var_to_str(actual)
    if _compare(actual, op, spec.get("value")):
        return _ok("", {"actual": shown_actual})
    return _bad(str(spec.node) + "." + property_path + " is " + shown_actual + ", expected " + op + " " + var_to_str(_literal(spec.get("value"))), {"actual": shown_actual})

func _send_action(action: String, pressed: bool) -> void:
    var event: InputEventAction = InputEventAction.new()
    event.action = action
    event.pressed = pressed
    Input.parse_input_event(event)

func _run_step(step: Dictionary) -> Dictionary:
    if step.has("wait"):
        await create_timer(float(step.wait)).timeout
        return _ok()
    if step.has("frames"):
        for i: int in range(int(step.frames)):
            await process_frame
        return _ok()
    if step.has("press"):
        var action: String = str(step.press)
        if not InputMap.has_action(action):
            return _bad("The input action " + action + " does not exist in the Input Map")
        _send_action(action, true)
        await create_timer(float(step.get("hold", 0.1))).timeout
        _send_action(action, false)
        await process_frame
        return _ok()
    if step.has("key"):
        var keycode: int = OS.find_keycode_from_string(str(step.key))
        if keycode == 0:
            return _bad("Unknown key " + str(step.key))
        var key_event: InputEventKey = InputEventKey.new()
        key_event.keycode = keycode as Key
        key_event.physical_keycode = keycode as Key
        key_event.pressed = true
        Input.parse_input_event(key_event)
        await create_timer(float(step.get("hold", 0.1))).timeout
        var release: InputEventKey = InputEventKey.new()
        release.keycode = keycode as Key
        release.physical_keycode = keycode as Key
        release.pressed = false
        Input.parse_input_event(release)
        await process_frame
        return _ok()
    if step.has("click"):
        var point: Array = step.click as Array
        var position: Vector2 = Vector2(float(point[0]), float(point[1]))
        var button: int = MOUSE_BUTTON_RIGHT if str(step.get("button", "left")) == "right" else MOUSE_BUTTON_LEFT
        var motion: InputEventMouseMotion = InputEventMouseMotion.new()
        motion.position = position
        motion.global_position = position
        Input.parse_input_event(motion)
        await process_frame
        for pressed: bool in [true, false]:
            var click: InputEventMouseButton = InputEventMouseButton.new()
            click.position = position
            click.global_position = position
            click.button_index = button as MouseButton
            click.pressed = pressed
            Input.parse_input_event(click)
            await process_frame
        return _ok()
    if step.has("set"):
        var spec: Dictionary = step.set as Dictionary
        var target: Node = _find(str(spec.get("node", "")))
        if target == null:
            return _bad("Node not found: " + str(spec.get("node", "")))
        var property_path: NodePath = NodePath(str(spec.get("property", "")))
        var new_value: Variant = _literal(spec.get("value"))
        # A text property takes text, even when the value reads as a number.
        if typeof(target.get_indexed(property_path)) == TYPE_STRING:
            new_value = str(new_value)
        target.set_indexed(property_path, new_value)
        return _ok()
    if step.has("call"):
        var call_spec: Dictionary = step.call as Dictionary
        var callee: Node = _find(str(call_spec.get("node", "")))
        if callee == null:
            return _bad("Node not found: " + str(call_spec.get("node", "")))
        var method: String = str(call_spec.get("method", ""))
        if not callee.has_method(method):
            return _bad(str(call_spec.node) + " has no method " + method)
        var returned: Variant = callee.callv(method, call_spec.get("args", []) as Array)
        return _ok("", {"returned": var_to_str(returned)})
    if step.has("assert"):
        return _check(step.assert as Dictionary)
    if step.has("wait_until"):
        var wait_spec: Dictionary = step.wait_until as Dictionary
        var deadline: int = Time.get_ticks_msec() + int(float(wait_spec.get("timeout", 5.0)) * 1000.0)
        var last: Dictionary = _check(wait_spec)
        while not bool(last.ok) and Time.get_ticks_msec() < deadline:
            await process_frame
            last = _check(wait_spec)
        if not bool(last.ok):
            last["message"] = "Timed out: " + str(last.message)
        return last
    if step.has("assert_no_errors"):
        var found: Array = _logger.snapshot()
        if found.is_empty():
            return _ok()
        return _bad(str(found.size()) + " error(s) so far; the first: " + str((found[0] as Dictionary).message), {"actual": found.slice(0, 5)})
    return _bad("A step needs one of: wait, frames, press, key, click, set, call, assert, wait_until, assert_no_errors")
