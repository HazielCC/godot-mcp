#!/usr/bin/env -S godot --path <project> --script render_scene_3d.gd
extends SceneTree

# Draws a 3D scene from several viewpoints and saves one PNG per view. The camera frames everything
# the scene shows, so it works for scenes that have no camera of their own. Needs a renderer, so it
# must not run with --headless.
#
# Usage: godot --path <project> --resolution WxH --script render_scene_3d.gd -- <scene> <out_dir> <views> <light>
#   views: comma list of iso, front, back, left, right, top
#   light: "auto" adds a sun and an environment when the scene has none, "none" leaves the scene as it is
# Prints "RENDER_OK <view> <path>" for each view, or "RENDER_FAIL <reason>".

const DIRECTIONS: Dictionary = {
    "iso": Vector3(1.0, 0.8, 1.0),
    "front": Vector3(0.0, 0.25, 1.0),
    "back": Vector3(0.0, 0.25, -1.0),
    "left": Vector3(-1.0, 0.25, 0.0),
    "right": Vector3(1.0, 0.25, 0.0),
    "top": Vector3(0.0, 1.0, 0.0),
}

var _out_dir: String = ""
var _views: PackedStringArray = PackedStringArray()
var _scene: Node = null
var _camera: Camera3D = null

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 4:
        _fail("usage: <scene> <out_dir> <views> <light>")
        return
    _out_dir = args[1]
    _views = args[2].split(",", false)
    for view: String in _views:
        if not DIRECTIONS.has(view):
            _fail("unknown view " + view)
            return

    var packed: PackedScene = load(args[0]) as PackedScene
    if packed == null:
        _fail("could not load " + args[0])
        return
    _scene = packed.instantiate()
    root.add_child(_scene)

    if args[3] == "auto":
        if _scene.find_children("*", "DirectionalLight3D", true, false).is_empty():
            var sun: DirectionalLight3D = DirectionalLight3D.new()
            sun.rotation_degrees = Vector3(-50.0, -35.0, 0.0)
            sun.shadow_enabled = true
            root.add_child(sun)
        if _scene.find_children("*", "WorldEnvironment", true, false).is_empty():
            var environment: Environment = Environment.new()
            environment.background_mode = Environment.BG_COLOR
            environment.background_color = Color(0.16, 0.18, 0.22)
            environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
            environment.ambient_light_color = Color(0.6, 0.62, 0.68)
            environment.ambient_light_energy = 0.7
            var holder: WorldEnvironment = WorldEnvironment.new()
            holder.environment = environment
            root.add_child(holder)

    _camera = Camera3D.new()
    root.add_child(_camera)
    _camera.current = true
    _run.call_deferred()

# Box that holds every visible mesh of the scene, in world space.
func _scene_bounds(node: Node, bounds: AABB, found: Array) -> AABB:
    if node is VisualInstance3D and (node as VisualInstance3D).is_visible_in_tree():
        var visual: VisualInstance3D = node as VisualInstance3D
        var box: AABB = visual.global_transform * visual.get_aabb()
        if found.is_empty():
            bounds = box
        else:
            bounds = bounds.merge(box)
        found.append(1)
    for child: Node in node.get_children():
        bounds = _scene_bounds(child, bounds, found)
    return bounds

func _run() -> void:
    for i: int in range(2):
        await process_frame
    var found: Array = []
    var bounds: AABB = _scene_bounds(_scene, AABB(), found)
    if found.is_empty() or bounds.size.length() <= 0.0:
        _fail("the scene shows nothing to draw")
        return
    var center: Vector3 = bounds.get_center()
    var radius: float = maxf(bounds.size.length() / 2.0, 0.5)
    var distance: float = radius / sin(deg_to_rad(_camera.fov / 2.0)) * 1.05
    _camera.far = maxf(distance + radius * 2.0, 100.0)
    DirAccess.make_dir_recursive_absolute(_out_dir)

    for view: String in _views:
        var direction: Vector3 = (DIRECTIONS[view] as Vector3).normalized()
        var up: Vector3 = Vector3.FORWARD if view == "top" else Vector3.UP
        _camera.look_at_from_position(center + direction * distance, center, up)
        for i: int in range(3):
            await process_frame
        await RenderingServer.frame_post_draw
        var image: Image = root.get_texture().get_image()
        if image == null:
            _fail("the window has no image; is a renderer available?")
            return
        var path: String = _out_dir.path_join(view + ".png")
        var error: Error = image.save_png(path)
        if error != OK:
            _fail("could not save " + path + ", error " + str(error))
            return
        print("RENDER_OK " + view + " " + path)
    quit()

func _fail(reason: String) -> void:
    print("RENDER_FAIL " + reason)
    quit(1)
