#!/usr/bin/env -S godot --path <project> --script render_particles.gd
extends SceneTree

# Plays the particles of a scene and takes a picture at chosen moments. The pictures go side by side in one PNG
# (a contact sheet), and for each moment the script measures what the particles add to the picture: how much of
# it they cover, the box that holds them and how bright they are. Needs a renderer, so it must not run with
# --headless.
#
# Usage: godot --path <project> --script render_particles.gd -- <scene> <out.png> <out.json> <times> <width> <height> <zoom> <background> <radius>
#   times: comma list of seconds after the particles start, for example 0.1,0.4,0.8
#   background: #rrggbb behind the particles
#   radius: 3D only, meters the camera frames around the emitter; 0 takes it from the emitter's visibility box
# Writes the sheet and the JSON and prints "RENDER_OK", or prints "RENDER_FAIL <reason>".

var _scene_path: String = ""
var _out_png: String = ""
var _out_json: String = ""
var _times: Array = []
var _cell: Vector2i = Vector2i(256, 256)
var _zoom: float = 1.0
var _background: Color = Color.BLACK
var _radius: float = 0.0

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 9:
        _fail("usage: <scene> <out.png> <out.json> <times> <width> <height> <zoom> <background> <radius>")
        return
    _scene_path = args[0]
    _out_png = args[1]
    _out_json = args[2]
    for entry: String in args[3].split(",", false):
        _times.append(float(entry))
    _cell = Vector2i(int(args[4]), int(args[5]))
    _zoom = float(args[6])
    _background = Color.html(args[7])
    _radius = float(args[8])
    _run.call_deferred()

func _emitters(node: Node, out: Array) -> void:
    if node is GPUParticles2D or node is GPUParticles3D or node is CPUParticles2D or node is CPUParticles3D:
        out.append(node)
    for child: Node in node.get_children():
        _emitters(child, out)

func _run() -> void:
    var packed: PackedScene = load(_scene_path) as PackedScene
    if packed == null:
        _fail("could not load " + _scene_path)
        return
    var viewport: SubViewport = SubViewport.new()
    viewport.size = _cell
    viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    root.add_child(viewport)
    var scene: Node = packed.instantiate()
    viewport.add_child(scene)

    var emitters: Array = []
    _emitters(scene, emitters)
    if emitters.is_empty():
        _fail("the scene has no GPUParticles or CPUParticles node")
        return

    var is_3d: bool = emitters[0] is GPUParticles3D or emitters[0] is CPUParticles3D
    if is_3d:
        _frame_3d(viewport, emitters)
    else:
        _frame_2d(viewport, emitters)

    # The same seed every run, so two runs of one scene give the same pictures.
    var info: Array = []
    for emitter: Node in emitters:
        if "use_fixed_seed" in emitter:
            emitter.set("use_fixed_seed", true)
            emitter.set("seed", 12345)
        info.append({"node": str(scene.name) + "/" + str(scene.get_path_to(emitter)), "class": emitter.get_class(), "amount": int(emitter.get("amount")), "lifetime": float(emitter.get("lifetime")), "one_shot": bool(emitter.get("one_shot"))})
        emitter.set("emitting", false)

    # A picture of the scene without particles: the rest of the scene (floor, walls, sprites) is not counted.
    for i: int in range(4):
        await process_frame
    await RenderingServer.frame_post_draw
    var baseline: Image = viewport.get_texture().get_image()
    if baseline == null:
        _fail("the viewport has no image; is a renderer available?")
        return
    baseline.convert(Image.FORMAT_RGBA8)
    for emitter: Node in emitters:
        emitter.call("restart")
        emitter.set("emitting", true)
    await process_frame
    var started: int = Time.get_ticks_msec()
    var frames: Array = []
    var sheet: Image = Image.create(_cell.x * _times.size(), _cell.y, false, Image.FORMAT_RGBA8)
    for index: int in range(_times.size()):
        var wanted: float = float(_times[index])
        while float(Time.get_ticks_msec() - started) / 1000.0 < wanted:
            await process_frame
        await RenderingServer.frame_post_draw
        var actual: float = float(Time.get_ticks_msec() - started) / 1000.0
        var image: Image = viewport.get_texture().get_image()
        if image == null:
            _fail("the viewport has no image; is a renderer available?")
            return
        image.convert(Image.FORMAT_RGBA8)
        sheet.blit_rect(image, Rect2i(Vector2i.ZERO, _cell), Vector2i(index * _cell.x, 0))
        var measured: Dictionary = _measure(image, baseline)
        measured["t"] = wanted
        measured["t_actual"] = snappedf(actual, 0.001)
        frames.append(measured)

    var error: Error = sheet.save_png(_out_png)
    if error != OK:
        _fail("could not save " + _out_png + ", error " + str(error))
        return
    var issues: Array = []
    var peak: float = 0.0
    for frame: Dictionary in frames:
        peak = maxf(peak, float(frame.coverage))
    if peak < 0.0005:
        issues.append({"severity": "error", "kind": "nothing_visible", "message": "No particles are visible at any of the sampled times", "suggestion": "Check that emitting is on, the amount is not 0, the texture exists and the camera frames the emitter (radius in 3D, zoom in 2D)"})
    elif float((frames[0] as Dictionary).coverage) < 0.0005 and not bool((info[0] as Dictionary).one_shot):
        issues.append({"severity": "info", "kind": "empty_start", "message": "Nothing shows at t=" + str((frames[0] as Dictionary).t) + " s", "suggestion": "Normal for a long lifetime or a slow start; use preprocess to fill the screen from the first frame"})
    var file: FileAccess = FileAccess.open(_out_json, FileAccess.WRITE)
    if file == null:
        _fail("could not write " + _out_json)
        return
    file.store_string(JSON.stringify({"frames": frames, "emitters": info, "issues": issues, "peak_coverage": peak, "cell": [_cell.x, _cell.y]}))
    file.close()
    print("RENDER_OK")
    quit()

# 2D: a camera on the first emitter, a little above it because particles usually rise.
func _frame_2d(viewport: SubViewport, emitters: Array) -> void:
    var background: ColorRect = ColorRect.new()
    background.color = _background
    background.size = Vector2(_cell)
    var layer: CanvasLayer = CanvasLayer.new()
    layer.layer = -100
    layer.add_child(background)
    viewport.add_child(layer)
    var camera: Camera2D = Camera2D.new()
    viewport.add_child(camera)
    camera.global_position = (emitters[0] as Node2D).global_position + Vector2(0.0, -float(_cell.y) * 0.2 / _zoom)
    camera.zoom = Vector2(_zoom, _zoom)
    camera.make_current()

# 3D: a camera looking at the middle of the emitter's reach from a diagonal.
func _frame_3d(viewport: SubViewport, emitters: Array) -> void:
    var environment: Environment = Environment.new()
    environment.background_mode = Environment.BG_COLOR
    environment.background_color = _background
    environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
    environment.ambient_light_color = Color(0.6, 0.6, 0.65)
    var holder: WorldEnvironment = WorldEnvironment.new()
    holder.environment = environment
    viewport.add_child(holder)
    var emitter: Node3D = emitters[0] as Node3D
    var radius: float = _radius
    var center: Vector3 = emitter.global_position
    if radius <= 0.0:
        var box: AABB = emitter.get("visibility_aabb")
        radius = maxf(box.size.length() * 0.25, 0.5)
        center = emitter.global_transform * box.get_center()
    var camera: Camera3D = Camera3D.new()
    viewport.add_child(camera)
    var distance: float = radius / sin(deg_to_rad(camera.fov / 2.0)) * 1.1
    camera.look_at_from_position(center + Vector3(1.0, 0.6, 1.0).normalized() * distance, center)
    camera.current = true

# What the particles cover in one picture: pixels that differ from the picture of the scene without particles.
func _measure(image: Image, baseline: Image) -> Dictionary:
    var lit: int = 0
    var total: int = 0
    var min_x: int = image.get_width()
    var min_y: int = image.get_height()
    var max_x: int = -1
    var max_y: int = -1
    var luma: float = 0.0
    for y: int in range(0, image.get_height(), 2):
        for x: int in range(0, image.get_width(), 2):
            total += 1
            var pixel: Color = image.get_pixel(x, y)
            var before: Color = baseline.get_pixel(x, y)
            if maxf(maxf(absf(pixel.r - before.r), absf(pixel.g - before.g)), absf(pixel.b - before.b)) > 0.04:
                lit += 1
                min_x = mini(min_x, x)
                min_y = mini(min_y, y)
                max_x = maxi(max_x, x)
                max_y = maxi(max_y, y)
                luma += 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b
    var box: Array = [0, 0, 0, 0]
    if lit > 0:
        box = [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1]
    return {"coverage": snappedf(float(lit) / float(maxi(total, 1)), 0.0001), "bbox": box, "mean_brightness": snappedf(luma / float(maxi(lit, 1)), 0.001)}

func _fail(reason: String) -> void:
    print("RENDER_FAIL " + reason)
    quit(1)
