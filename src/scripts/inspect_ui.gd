#!/usr/bin/env -S godot --path <project> --script inspect_ui.gd
extends SceneTree

# Opens a UI scene in a SubViewport of a given size, lets it lay out, and checks it. Needs a renderer (text
# sizes and pixels come from a real draw), so it must not run with --headless.
#
# Usage: godot --path <project> --script inspect_ui.gd -- <scene> <mode> <width> <height> <pseudo 0|1> <out.json> <min_touch>
#   mode: lint, focus or contrast
# Writes the result as JSON to <out.json> and prints "INSPECT_OK", or prints "INSPECT_FAIL <reason>".

var _scene_path: String = ""
var _mode: String = ""
var _size: Vector2i = Vector2i(1280, 720)
var _pseudo: bool = false
var _out_path: String = ""
var _min_touch: float = 44.0
var _viewport: SubViewport = null
var _scene: Node = null

func _initialize() -> void:
    var args: PackedStringArray = OS.get_cmdline_user_args()
    if args.size() < 7:
        _fail("usage: <scene> <mode> <width> <height> <pseudo> <out.json> <min_touch>")
        return
    _scene_path = args[0]
    _mode = args[1]
    _size = Vector2i(int(args[2]), int(args[3]))
    _pseudo = args[4] == "1"
    _out_path = args[5]
    _min_touch = float(args[6])
    if not (_mode in ["lint", "focus", "contrast"]):
        _fail("unknown mode " + _mode)
        return
    var packed: PackedScene = load(_scene_path) as PackedScene
    if packed == null:
        _fail("could not load " + _scene_path)
        return
    _viewport = SubViewport.new()
    _viewport.size = _size
    _viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    root.add_child(_viewport)
    _scene = packed.instantiate()
    if _pseudo:
        _pseudo_localize(_scene)
    _viewport.add_child(_scene)
    _run.call_deferred()

func _run() -> void:
    for i: int in range(5):
        await process_frame
    await RenderingServer.frame_post_draw
    var result: Dictionary = {}
    match _mode:
        "lint":
            result = _lint()
        "focus":
            result = _focus()
        "contrast":
            result = _contrast(_viewport.get_texture().get_image())
    result["size"] = [_size.x, _size.y]
    result["pseudo_localized"] = _pseudo
    var file: FileAccess = FileAccess.open(_out_path, FileAccess.WRITE)
    if file == null:
        _fail("could not write " + _out_path)
        return
    file.store_string(JSON.stringify(result))
    file.close()
    print("INSPECT_OK")
    quit()

func _fail(reason: String) -> void:
    print("INSPECT_FAIL " + reason)
    quit(1)

# --- helpers

func _controls(node: Node, out: Array) -> void:
    if node is Control:
        out.append(node)
    for child: Node in node.get_children():
        _controls(child, out)

func _path_of(node: Node) -> String:
    if node == _scene:
        return str(_scene.name)
    return str(_scene.name) + "/" + str(_scene.get_path_to(node))

func _issue(issues: Array, node: Node, kind: String, severity: String, message: String, suggestion: String) -> void:
    issues.append({"node": _path_of(node), "kind": kind, "severity": severity, "message": message, "suggestion": suggestion})

func _inside_scroll(control: Control) -> bool:
    var current: Node = control.get_parent()
    while current != null and current != _viewport:
        if current is ScrollContainer:
            return true
        current = current.get_parent()
    return false

func _is_interactive(control: Control) -> bool:
    return control is BaseButton or control is LineEdit or control is TextEdit or (control is Range and not (control is ProgressBar)) or control is ItemList or control is Tree

func _summary(issues: Array) -> Dictionary:
    var counts: Dictionary = {"error": 0, "warning": 0, "info": 0}
    for issue: Dictionary in issues:
        counts[issue.severity] = int(counts[issue.severity]) + 1
    return counts

# Longer text with accents, to see how the layout copes with other languages.
func _pseudo_text(text: String) -> String:
    var map: Dictionary = {"a": "à", "e": "é", "i": "î", "o": "õ", "u": "ü", "A": "À", "E": "É", "I": "Î", "O": "Õ", "U": "Ü"}
    var out: String = ""
    for character: String in text:
        out += str(map.get(character, character))
    return "[" + out + " " + "~".repeat(int(ceil(text.length() * 0.4))) + "]"

func _pseudo_localize(node: Node) -> void:
    if node is Label or node is Button:
        var current: String = str(node.get("text"))
        if current.strip_edges() != "":
            node.set("text", _pseudo_text(current))
    for child: Node in node.get_children():
        _pseudo_localize(child)

# --- lint

func _lint() -> Dictionary:
    var issues: Array = []
    var controls: Array = []
    _controls(_scene, controls)
    var view: Rect2 = Rect2(Vector2.ZERO, Vector2(_size))

    if _scene is Control:
        var root_control: Control = _scene as Control
        if root_control.size.distance_to(Vector2(_size)) > 1.0 and not (root_control is Container and root_control.get_parent() == null):
            _issue(issues, root_control, "root_size", "info", "The root control is " + str(root_control.size) + " in a " + str(_size) + " viewport", "Give it anchors full_rect so it fills the screen at every size")

    for control: Control in controls:
        if not control.is_visible_in_tree():
            continue
        var rect: Rect2 = control.get_global_rect()
        var scrolls: bool = _inside_scroll(control)
        var shows_something: bool = control is Label or control is BaseButton or control is TextureRect or control is LineEdit or control is Panel or control is ColorRect
        var takes_space: bool = shows_something or control is Container

        if shows_something and (rect.size.x <= 0.0 or rect.size.y <= 0.0):
            _issue(issues, control, "no_size", "warning", "It has no size, so it is not visible", "Set custom_minimum_size, or put it in a container that gives it room")
            continue
        if not scrolls and takes_space and rect.size.x > 0.0 and rect.size.y > 0.0:
            if not rect.intersects(view):
                _issue(issues, control, "offscreen", "error", "It is outside the " + str(_size) + " viewport (at " + str(rect.position) + ")", "Move it inside, or anchor it to an edge or the center")
            elif not view.encloses(rect.grow(-0.5)):
                _issue(issues, control, "clipped", "warning", "It sticks out of the viewport by up to " + str(snappedf(maxf(maxf(-rect.position.x, -rect.position.y), maxf(rect.end.x - view.size.x, rect.end.y - view.size.y)), 0.1)) + " px", "Use anchors or a container so it fits at this size")

        var parent: Control = control.get_parent() as Control
        if parent != null and not scrolls and not (parent is ScrollContainer) and not control.clip_contents:
            var parent_rect: Rect2 = parent.get_global_rect()
            if shows_something and not parent_rect.grow(1.0).encloses(rect) and parent_rect.size.x > 0.0:
                _issue(issues, control, "overflows_parent", "warning", "It extends beyond its parent " + str(parent.name) + " (needs " + str(control.get_combined_minimum_size()) + ", parent is " + str(parent.size) + ")", "Let the text wrap (autowrap_mode), shorten it, or give the parent more room")

        if control is Label:
            var label: Label = control as Label
            if label.text != "" and label.autowrap_mode == TextServer.AUTOWRAP_OFF:
                var width: float = label.get_theme_font("font").get_string_size(label.text, HORIZONTAL_ALIGNMENT_LEFT, -1, label.get_theme_font_size("font_size")).x
                if width > label.size.x + 1.0:
                    var truncated: bool = label.clip_text or label.text_overrun_behavior != TextServer.OVERRUN_NO_TRIMMING
                    _issue(issues, label, "text_clipped", "error" if truncated else "warning", "The text is " + str(snappedf(width, 0.1)) + " px wide in a " + str(snappedf(label.size.x, 0.1)) + " px label" + (" and is cut off" if truncated else ""), "Turn on autowrap_mode or widen the label")
            elif label.text != "" and label.get_line_count() > label.get_visible_line_count() and label.get_visible_line_count() > 0:
                _issue(issues, label, "text_clipped", "error", "Only " + str(label.get_visible_line_count()) + " of " + str(label.get_line_count()) + " lines show", "Give the label more height, or shorten the text")
        elif control is Button:
            var button: Button = control as Button
            if button.clip_text and button.text != "":
                var text_width: float = button.get_theme_font("font").get_string_size(button.text, HORIZONTAL_ALIGNMENT_LEFT, -1, button.get_theme_font_size("font_size")).x
                if text_width > button.size.x - 8.0:
                    _issue(issues, button, "text_clipped", "error", "The text is " + str(snappedf(text_width, 0.1)) + " px wide in a " + str(snappedf(button.size.x, 0.1)) + " px button and is cut off", "Widen the button or shorten the text")

        if _is_interactive(control) and _min_touch > 0.0 and minf(rect.size.x, rect.size.y) < _min_touch:
            _issue(issues, control, "touch_target", "warning", "It is " + str(snappedf(rect.size.x, 0.1)) + " x " + str(snappedf(rect.size.y, 0.1)) + " px; touch targets should be at least " + str(_min_touch) + " px", "Raise custom_minimum_size")

        # Overlaps between siblings that are placed freely (not by a container).
        if not (control is Container) and control.get_parent() != null and not (control.get_parent() is Container):
            var siblings: Array = control.get_parent().get_children()
            var index: int = siblings.find(control)
            for later_index: int in range(index + 1, siblings.size()):
                var upper: Control = siblings[later_index] as Control
                if upper == null or not upper.is_visible_in_tree():
                    continue
                var overlap: Rect2 = rect.intersection(upper.get_global_rect())
                var smaller: float = minf(rect.get_area(), upper.get_global_rect().get_area())
                if smaller <= 0.0 or overlap.get_area() < smaller * 0.25:
                    continue
                if _is_interactive(control) and upper.mouse_filter == Control.MOUSE_FILTER_STOP and not _is_interactive(upper):
                    _issue(issues, upper, "blocks_input", "error", "It covers " + str(control.name) + " and its mouse_filter is Stop, so clicks never reach it", "Set mouse_filter to Ignore, or move it behind")
                elif (control is Label or control is Button) and (upper is Label or upper is Button):
                    _issue(issues, upper, "overlap", "warning", "It overlaps " + str(control.name) + " by " + str(int(overlap.get_area() / smaller * 100.0)) + " % of the smaller one", "Put both in a container, or move one")

    return {"issues": issues, "counts": _summary(issues), "controls": controls.size()}

# --- focus

func _focus() -> Dictionary:
    var issues: Array = []
    var controls: Array = []
    _controls(_scene, controls)
    var focusables: Array = []
    for control: Control in controls:
        if control.is_visible_in_tree() and control.focus_mode != Control.FOCUS_NONE and not (control is BaseButton and (control as BaseButton).disabled):
            focusables.append(control)
    if focusables.is_empty():
        issues.append({"node": _path_of(_scene), "kind": "no_focusable", "severity": "error", "message": "No control can take focus, so keyboard and gamepad users cannot use this screen", "suggestion": "Use buttons, or set focus_mode to All on the controls that act"})
        return {"issues": issues, "counts": _summary(issues), "focusable": [], "tab_order": [], "arrow_unreachable": [], "tab_skipped": []}

    # Arrow keys: the neighbor that Godot finds on each side.
    var edges: Dictionary = {}
    var neighbor_paths: Array = ["focus_neighbor_left", "focus_neighbor_top", "focus_neighbor_right", "focus_neighbor_bottom", "focus_next", "focus_previous"]
    for control: Control in focusables:
        var targets: Array = []
        for side: int in [SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM]:
            var neighbor: Control = control.find_valid_focus_neighbor(side as Side)
            if neighbor != null and neighbor != control and focusables.has(neighbor):
                targets.append(neighbor)
        edges[control.get_instance_id()] = targets
        for property_name: String in neighbor_paths:
            var path: NodePath = control.get(property_name) as NodePath
            if not path.is_empty() and control.get_node_or_null(path) == null:
                _issue(issues, control, "bad_neighbor", "error", property_name + " points to " + str(path) + ", which does not exist", "Fix or clear the path")
        var focus_style: StyleBox = control.get_theme_stylebox("focus") if control.has_theme_stylebox("focus") else null
        if control.has_theme_stylebox("focus") and focus_style is StyleBoxEmpty:
            _issue(issues, control, "no_focus_style", "warning", "Its focus style is empty, so nobody can see where the focus is", "Give the theme a focus stylebox (make_theme does)")
        if edges[control.get_instance_id()].is_empty() and focusables.size() > 1:
            _issue(issues, control, "dead_end", "warning", "No arrow key leads out of this control", "Check focus_neighbor_* or the layout")

    var visited: Dictionary = {}
    var queue: Array = [focusables[0]]
    visited[(focusables[0] as Control).get_instance_id()] = true
    while not queue.is_empty():
        var current: Control = queue.pop_front() as Control
        for next: Control in edges[current.get_instance_id()]:
            if not visited.has(next.get_instance_id()):
                visited[next.get_instance_id()] = true
                queue.append(next)
    var arrow_unreachable: Array = []
    for control: Control in focusables:
        if not visited.has(control.get_instance_id()):
            arrow_unreachable.append(_path_of(control))
            _issue(issues, control, "unreachable_by_arrows", "error", "Arrow keys or a gamepad cannot reach it from " + _path_of(focusables[0] as Node), "Set focus_neighbor_* so the focus can move here")

    # Tab: follow find_next_valid_focus() once around.
    var tab_order: Array = []
    var tab_seen: Dictionary = {}
    var cursor: Control = focusables[0] as Control
    while cursor != null and not tab_seen.has(cursor.get_instance_id()) and tab_order.size() <= focusables.size() + 1:
        tab_seen[cursor.get_instance_id()] = true
        tab_order.append(_path_of(cursor))
        cursor = cursor.find_next_valid_focus()
    var tab_skipped: Array = []
    for control: Control in focusables:
        if not tab_seen.has(control.get_instance_id()):
            tab_skipped.append(_path_of(control))
            _issue(issues, control, "skipped_by_tab", "warning", "Tab never lands on it", "Check focus_next and focus_previous")

    if _viewport.gui_get_focus_owner() == null:
        issues.append({"node": _path_of(_scene), "kind": "no_initial_focus", "severity": "info", "message": "Nothing has focus when the screen opens, so a gamepad or keyboard user has to press a key first", "suggestion": "Call grab_focus() on the first control in _ready"})

    var listed: Array = []
    for control: Control in focusables:
        listed.append({"node": _path_of(control), "class": control.get_class(), "focus_mode": control.focus_mode})
    return {"issues": issues, "counts": _summary(issues), "focusable": listed, "tab_order": tab_order, "arrow_unreachable": arrow_unreachable, "tab_skipped": tab_skipped}

# --- contrast

func _luminance(color: Color) -> float:
    var linear: Array = []
    for channel: float in [color.r, color.g, color.b]:
        linear.append(channel / 12.92 if channel <= 0.03928 else pow((channel + 0.055) / 1.055, 2.4))
    return 0.2126 * float(linear[0]) + 0.7152 * float(linear[1]) + 0.0722 * float(linear[2])

func _ratio(first: Color, second: Color) -> float:
    var a: float = _luminance(first)
    var b: float = _luminance(second)
    return (maxf(a, b) + 0.05) / (minf(a, b) + 0.05)

# The most common color inside a rectangle of the drawn image, which is the background behind the text,
# and the share of the sampled pixels that have it.
func _background_of(image: Image, rect: Rect2i) -> Dictionary:
    var step: int = maxi(1, int(ceil(sqrt(float(rect.size.x * rect.size.y) / 2500.0))))
    var counts: Dictionary = {}
    var sums: Dictionary = {}
    var total: int = 0
    var y: int = rect.position.y
    while y < rect.end.y:
        var x: int = rect.position.x
        while x < rect.end.x:
            var pixel: Color = image.get_pixel(x, y)
            var key: int = (int(pixel.r * 31.0) << 10) | (int(pixel.g * 31.0) << 5) | int(pixel.b * 31.0)
            counts[key] = int(counts.get(key, 0)) + 1
            sums[key] = (sums.get(key, Color(0, 0, 0, 0)) as Color) + Color(pixel.r, pixel.g, pixel.b, 1.0)
            total += 1
            x += step
        y += step
    var best_key: int = -1
    var best_count: int = 0
    for key: int in counts:
        if int(counts[key]) > best_count:
            best_count = int(counts[key])
            best_key = key
    if best_key == -1:
        return {"color": Color.BLACK, "share": 0.0}
    var sum: Color = sums[best_key]
    return {"color": Color(sum.r / sum.a, sum.g / sum.a, sum.b / sum.a), "share": float(best_count) / float(total)}

func _contrast(image: Image) -> Dictionary:
    var issues: Array = []
    var checked: Array = []
    var controls: Array = []
    _controls(_scene, controls)
    var view: Rect2i = Rect2i(Vector2i.ZERO, _size)
    for control: Control in controls:
        if not control.is_visible_in_tree():
            continue
        var text: String = ""
        var color: Color = Color.WHITE
        if control is Label:
            text = (control as Label).text
            color = control.get_theme_color("font_color")
        elif control is Button:
            var button: Button = control as Button
            text = button.text
            if button.disabled:
                continue
            color = control.get_theme_color("font_color")
        elif control is LineEdit:
            var line: LineEdit = control as LineEdit
            if line.text != "":
                text = line.text
                color = control.get_theme_color("font_color")
            else:
                text = line.placeholder_text
                color = control.get_theme_color("font_placeholder_color")
        if text.strip_edges() == "":
            continue
        var rect: Rect2i = Rect2i(control.get_global_rect()).intersection(view)
        if rect.size.x <= 0 or rect.size.y <= 0:
            continue
        var background: Dictionary = _background_of(image, rect)
        var back: Color = background.color
        var effective: Color = back.lerp(Color(color.r, color.g, color.b), color.a)
        var ratio: float = _ratio(effective, back)
        var font_size: int = control.get_theme_font_size("font_size")
        var required: float = 3.0 if font_size >= 24 else 4.5
        var passes: bool = ratio >= required
        var entry: Dictionary = {
            "node": _path_of(control),
            "text": text.substr(0, 40),
            "text_color": "#" + color.to_html(false),
            "background": "#" + back.to_html(false),
            "ratio": snappedf(ratio, 0.01),
            "required": required,
            "passes": passes,
            "confidence": "high" if float(background.share) >= 0.5 else "low",
        }
        if not passes:
            var better: Color = Color.WHITE if _ratio(Color.WHITE, back) >= _ratio(Color.BLACK, back) else Color.BLACK
            entry["suggested_text_color"] = "#" + better.to_html(false)
            entry["suggested_ratio"] = snappedf(_ratio(better, back), 0.01)
            _issue(issues, control, "low_contrast", "error", "Contrast " + str(snappedf(ratio, 0.01)) + ":1, needs " + str(required) + ":1 (text " + entry.text_color + " on " + entry.background + ")", "Use " + str(entry.suggested_text_color) + " (" + str(entry.suggested_ratio) + ":1), or change the background")
        checked.append(entry)
    return {"issues": issues, "counts": _summary(issues), "checked": checked}
