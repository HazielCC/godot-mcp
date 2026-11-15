#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Loads GDScript files the way the running game does: after the project's autoloads are
# registered, so autoload names and global classes resolve. Compile errors are printed in
# Godot's "SCRIPT ERROR" format, which the MCP server parses. Files that cannot be loaded at
# all are printed as "CHECK_FAIL <path>".
#
# Usage: godot --headless --path <project> --script check_scripts.gd -- [res://file.gd ...]
# Without file arguments, every .gd file in the project is checked.

func _init() -> void:
    # Defer the work so that autoloads exist when the scripts are compiled.
    call_deferred("_run")

func _run() -> void:
    var files: Array = []
    var requested: PackedStringArray = OS.get_cmdline_user_args()
    if requested.is_empty():
        _collect("res://", files)
    else:
        for path: String in requested:
            files.append(path)

    var failed: int = 0
    for path: String in files:
        var script: Resource = ResourceLoader.load(path, "GDScript", ResourceLoader.CACHE_MODE_IGNORE)
        if script == null:
            failed += 1
            print("CHECK_FAIL " + path)

    print("CHECK_DONE total=" + str(files.size()) + " failed=" + str(failed))
    quit()

# Collect .gd files under dir_path, skipping hidden folders such as .godot.
func _collect(dir_path: String, out: Array) -> void:
    var dir: DirAccess = DirAccess.open(dir_path)
    if dir == null:
        return
    dir.list_dir_begin()
    var entry: String = dir.get_next()
    while entry != "":
        if entry.begins_with("."):
            entry = dir.get_next()
            continue
        var full_path: String = dir_path + entry
        if dir.current_is_dir():
            _collect(full_path + "/", out)
        elif entry.ends_with(".gd"):
            out.append(full_path)
        entry = dir.get_next()
