#!/usr/bin/env -S godot --headless --script image_diff.gd
extends SceneTree

# Compares two PNG files pixel by pixel and writes a picture of the difference. Runs headless.
#
# Usage: godot --headless --path <project> --script image_diff.gd -- <baseline.png> <current.png> <diff.png> <tolerance> <out.json>
#   tolerance: the largest change of a color channel (0 to 1) that still counts as equal
# Writes <out.json> and prints "DIFF_DONE", or prints "DIFF_FAIL <reason>".

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 5:
        print("DIFF_FAIL usage: <baseline.png> <current.png> <diff.png> <tolerance> <out.json>")
        quit(1)
        return
    var baseline: Image = Image.load_from_file(args[0])
    var current: Image = Image.load_from_file(args[1])
    if baseline == null or current == null:
        print("DIFF_FAIL could not read the images")
        quit(1)
        return
    baseline.convert(Image.FORMAT_RGBA8)
    current.convert(Image.FORMAT_RGBA8)
    var result: Dictionary = {"baseline_size": [baseline.get_width(), baseline.get_height()], "current_size": [current.get_width(), current.get_height()]}
    if baseline.get_size() != current.get_size():
        result["size_mismatch"] = true
    else:
        var tolerance: float = float(args[3])
        var width: int = current.get_width()
        var height: int = current.get_height()
        var diff: Image = Image.create(width, height, false, Image.FORMAT_RGBA8)
        var different: int = 0
        var max_delta: float = 0.0
        var min_x: int = width
        var min_y: int = height
        var max_x: int = -1
        var max_y: int = -1
        for y: int in range(height):
            for x: int in range(width):
                var a: Color = baseline.get_pixel(x, y)
                var b: Color = current.get_pixel(x, y)
                var delta: float = maxf(maxf(absf(a.r - b.r), absf(a.g - b.g)), maxf(absf(a.b - b.b), absf(a.a - b.a)))
                if delta > tolerance:
                    different += 1
                    max_delta = maxf(max_delta, delta)
                    min_x = mini(min_x, x)
                    min_y = mini(min_y, y)
                    max_x = maxi(max_x, x)
                    max_y = maxi(max_y, y)
                    diff.set_pixel(x, y, Color(1.0, 0.1, 0.1, 1.0))
                else:
                    diff.set_pixel(x, y, Color(b.r * 0.35, b.g * 0.35, b.b * 0.35, 1.0))
        result["size_mismatch"] = false
        result["different_pixels"] = different
        result["total_pixels"] = width * height
        result["percent"] = snappedf(float(different) * 100.0 / float(maxi(width * height, 1)), 0.0001)
        result["max_delta"] = snappedf(max_delta, 0.001)
        result["bbox"] = [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1] if different > 0 else [0, 0, 0, 0]
        var saved: Error = diff.save_png(args[2])
        if saved != OK:
            print("DIFF_FAIL could not save " + args[2])
            quit(1)
            return
    var file: FileAccess = FileAccess.open(args[4], FileAccess.WRITE)
    if file == null:
        print("DIFF_FAIL could not write " + args[4])
        quit(1)
        return
    file.store_string(JSON.stringify(result))
    file.close()
    print("DIFF_DONE")
    quit()
