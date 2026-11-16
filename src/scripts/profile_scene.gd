#!/usr/bin/env -S godot --path <project> --script profile_scene.gd
extends SceneTree

# Runs a scene in a window for some seconds with the frame limit off, and records how long frames take and
# what the engine's monitors report. Needs a renderer, so it must not run with --headless.
#
# Usage: godot --path <project> --script profile_scene.gd -- <scene> <out.json> <width> <height> <warmup_s> <seconds>
# Writes <out.json> and prints "PROFILE_DONE", or prints "PROFILE_FAIL <reason>".

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 6:
        print("PROFILE_FAIL usage: <scene> <out.json> <width> <height> <warmup_s> <seconds>")
        quit(1)
        return
    _run.call_deferred(args[0], args[1], Vector2i(int(args[2]), int(args[3])), float(args[4]), float(args[5]))

func _percentile(sorted_values: Array, fraction: float) -> float:
    if sorted_values.is_empty():
        return 0.0
    var index: int = clampi(int(ceil(fraction * sorted_values.size())) - 1, 0, sorted_values.size() - 1)
    return float(sorted_values[index])

func _run(scene_path: String, out_path: String, size: Vector2i, warmup: float, seconds: float) -> void:
    var packed: PackedScene = load(scene_path) as PackedScene
    if packed == null:
        print("PROFILE_FAIL could not load " + scene_path)
        quit(1)
        return
    DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
    Engine.max_fps = 0
    var viewport: SubViewport = SubViewport.new()
    viewport.size = size
    viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    root.add_child(viewport)
    viewport.add_child(packed.instantiate())

    var warm_until: int = Time.get_ticks_msec() + int(warmup * 1000.0)
    while Time.get_ticks_msec() < warm_until:
        await process_frame

    var frame_ms: Array = []
    var draw_calls: Array = []
    var max_nodes: float = 0.0
    var max_objects: float = 0.0
    var max_primitives: float = 0.0
    var process_ms: float = 0.0
    var physics_ms: float = 0.0
    var end: int = Time.get_ticks_msec() + int(seconds * 1000.0)
    var last: int = Time.get_ticks_usec()
    var begun: int = last
    while Time.get_ticks_msec() < end:
        await process_frame
        var now: int = Time.get_ticks_usec()
        frame_ms.append(float(now - last) / 1000.0)
        last = now
        draw_calls.append(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
        max_nodes = maxf(max_nodes, Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
        max_objects = maxf(max_objects, Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME))
        max_primitives = maxf(max_primitives, Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME))
        process_ms += Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
        physics_ms += Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0

    var count: int = maxi(frame_ms.size(), 1)
    var sorted_ms: Array = frame_ms.duplicate()
    sorted_ms.sort()
    var total_ms: float = 0.0
    for value: float in frame_ms:
        total_ms += value
    var draw_total: float = 0.0
    var draw_max: float = 0.0
    for value: float in draw_calls:
        draw_total += value
        draw_max = maxf(draw_max, value)
    var result: Dictionary = {
        "frames": frame_ms.size(),
        "seconds": snappedf(float(Time.get_ticks_usec() - begun) / 1000000.0, 0.01),
        "fps": snappedf(float(frame_ms.size()) / maxf(float(Time.get_ticks_usec() - begun) / 1000000.0, 0.001), 0.1),
        "frame_ms_avg": snappedf(total_ms / count, 0.01),
        "frame_ms_p95": snappedf(_percentile(sorted_ms, 0.95), 0.01),
        "frame_ms_p99": snappedf(_percentile(sorted_ms, 0.99), 0.01),
        "frame_ms_max": snappedf(float(sorted_ms.back()) if not sorted_ms.is_empty() else 0.0, 0.01),
        "draw_calls_avg": snappedf(draw_total / count, 0.1),
        "draw_calls_max": draw_max,
        "objects_max": max_objects,
        "primitives_max": max_primitives,
        "nodes_max": max_nodes,
        "process_ms_avg": snappedf(process_ms / count, 0.01),
        "physics_ms_avg": snappedf(physics_ms / count, 0.01),
        "memory_mb": snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.1),
        "video_memory_mb": snappedf(Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0, 0.1),
        "size": [size.x, size.y],
        "renderer": str(RenderingServer.get_rendering_device().get_device_name()) if RenderingServer.get_rendering_device() != null else str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "")),
    }
    var file: FileAccess = FileAccess.open(out_path, FileAccess.WRITE)
    if file == null:
        print("PROFILE_FAIL could not write " + out_path)
        quit(1)
        return
    file.store_string(JSON.stringify(result))
    file.close()
    print("PROFILE_DONE")
    quit()
