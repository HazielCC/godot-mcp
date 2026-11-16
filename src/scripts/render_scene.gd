#!/usr/bin/env -S godot --path <project> --script render_scene.gd
extends SceneTree

# Draws a scene for a few frames and saves what the window shows as a PNG. Unlike the other scripts
# this one needs a renderer, so it must not run with --headless.
#
# Usage: godot --path <project> --resolution WxH --script render_scene.gd -- <scene> <out.png> [zoom] [center_x] [center_y]
# Prints "RENDER_OK <out.png>" or "RENDER_FAIL <reason>".

var _out_path: String = ""

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 2:
        _fail("usage: <scene> <out.png> [zoom] [center_x] [center_y]")
        return
    var scene_path: String = args[0]
    _out_path = args[1]
    var zoom: float = float(args[2]) if args.size() > 2 else 1.0
    if zoom <= 0.0:
        _fail("zoom must be greater than 0")
        return

    var packed: PackedScene = load(scene_path) as PackedScene
    if packed == null:
        _fail("could not load " + scene_path)
        return
    root.add_child(packed.instantiate())

    # A scene with its own Camera2D keeps it. Otherwise zoom and center place the view.
    if args.size() > 4 or zoom != 1.0:
        var size: Vector2 = Vector2(root.size)
        var center: Vector2 = Vector2(float(args[3]), float(args[4])) if args.size() > 4 else size / 2.0
        root.canvas_transform = Transform2D(0.0, Vector2(zoom, zoom), 0.0, size / 2.0 - center * zoom)
    _capture.call_deferred()

func _capture() -> void:
    # Let the scene run a few frames so _ready and the first draw have happened.
    for i: int in range(3):
        await process_frame
    await RenderingServer.frame_post_draw
    var image: Image = root.get_texture().get_image()
    if image == null:
        _fail("the window has no image; is a renderer available?")
        return
    var error: Error = image.save_png(_out_path)
    if error != OK:
        _fail("could not save " + _out_path + ", error " + str(error))
        return
    print("RENDER_OK " + _out_path)
    quit()

func _fail(reason: String) -> void:
    print("RENDER_FAIL " + reason)
    quit(1)
