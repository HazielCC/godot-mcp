#!/usr/bin/env -S godot --path <project> --script render_scene_ui.gd
extends SceneTree

# Draws a UI scene at several sizes and saves one PNG per size. Each size is a SubViewport, so a size larger
# than the screen works, and the scene lays itself out for that size. Needs a renderer, so it must not run
# with --headless.
#
# Usage: godot --path <project> --script render_scene_ui.gd -- <scene> <out_dir> <sizes>
#   sizes: comma list of WIDTHxHEIGHT, for example 390x844,1280x720
# Prints "RENDER_OK <size> <path>" for each size, or "RENDER_FAIL <reason>".

var _scene_path: String = ""
var _out_dir: String = ""
var _sizes: Array = []

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 3:
        _fail("usage: <scene> <out_dir> <sizes>")
        return
    _scene_path = args[0]
    _out_dir = args[1]
    for entry: String in args[2].split(",", false):
        var parts: PackedStringArray = entry.split("x")
        if parts.size() != 2 or int(parts[0]) < 16 or int(parts[1]) < 16:
            _fail("bad size " + entry)
            return
        _sizes.append(Vector2i(int(parts[0]), int(parts[1])))
    _run.call_deferred()

func _run() -> void:
    var packed: PackedScene = load(_scene_path) as PackedScene
    if packed == null:
        _fail("could not load " + _scene_path)
        return
    DirAccess.make_dir_recursive_absolute(_out_dir)
    for size: Vector2i in _sizes:
        var viewport: SubViewport = SubViewport.new()
        viewport.size = size
        viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
        root.add_child(viewport)
        viewport.add_child(packed.instantiate())
        # Containers lay out on the first frames; wait until they have.
        for i: int in range(4):
            await process_frame
        await RenderingServer.frame_post_draw
        var image: Image = viewport.get_texture().get_image()
        if image == null:
            _fail("the viewport has no image; is a renderer available?")
            return
        var label: String = "%dx%d" % [size.x, size.y]
        var path: String = _out_dir.path_join(label + ".png")
        var error: Error = image.save_png(path)
        if error != OK:
            _fail("could not save " + path + ", error " + str(error))
            return
        print("RENDER_OK " + label + " " + path)
        root.remove_child(viewport)
        viewport.free()
    quit()

func _fail(reason: String) -> void:
    print("RENDER_FAIL " + reason)
    quit(1)
