#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode: bool = false

# Set by _fail; operations that finish after _init use it to keep their error exit code.
var _failed: bool = false
var _deferred_params: Dictionary = {}

func _init() -> void:
    var args: PackedStringArray = OS.get_cmdline_args()

    # Check for debug flag
    debug_mode = "--debug-godot" in args

    # Find the script argument and determine the positions of operation and params
    var script_index: int = args.find("--script")
    if script_index == -1:
        log_error("Could not find --script argument")
        quit(1)

    # The operation should be 2 positions after the script path (script_index + 1 is the script path itself)
    var operation_index: int = script_index + 2
    # The params should be 3 positions after the script path
    var params_index: int = script_index + 3

    if args.size() <= params_index:
        log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
        log_error("Not enough command-line arguments provided.")
        quit(1)

    # Log all arguments for debugging
    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))

    var operation: String = args[operation_index]
    var params_json: String = args[params_index]

    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)

    # Parse JSON using Godot 4.x API
    var json: JSON = JSON.new()
    var error: Error = json.parse(params_json)
    var params: Variant = null

    if error == OK:
        params = json.get_data()
    else:
        log_error("Failed to parse JSON parameters: " + params_json)
        log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
        quit(1)

    if not params:
        log_error("Failed to parse JSON parameters: " + params_json)
        quit(1)

    log_info("Executing operation: " + operation)

    match operation:
        "create_scene":
            create_scene(params)
        "add_node":
            add_node(params)
        "load_sprite":
            load_sprite(params)
        "export_mesh_library":
            export_mesh_library(params)
        "save_scene":
            save_scene(params)
        "set_node_property":
            set_node_property(params)
        "inspect_node":
            inspect_node(params)
        "get_uid":
            get_uid(params)
        "resave_resources":
            resave_resources(params)
        "import_spritesheet":
            import_spritesheet(params)
        "auto_collision":
            auto_collision(params)
        "build_tilemap":
            build_tilemap(params)
        "setup_parallax_2d":
            setup_parallax_2d(params)
        "build_blockout":
            build_blockout(params)
        "create_pbr_material":
            create_pbr_material(params)
        "extract_mesh":
            extract_mesh(params)
        "build_ui":
            build_ui(params)
        "make_theme":
            make_theme(params)
        "bake_navmesh":
            # Reading geometry needs the scene inside a running tree, which only exists after _init.
            _deferred_params = params
            process_frame.connect(_run_bake_navmesh, CONNECT_ONE_SHOT)
            return
        _:
            log_error("Unknown operation: " + operation)
            quit(1)

    quit()

# Logging functions
func log_debug(message: String) -> void:
    if debug_mode:
        print("[DEBUG] " + message)

func log_info(message: String) -> void:
    print("[INFO] " + message)

func log_error(message: String) -> void:
    printerr("[ERROR] " + message)

# Get a script by registered class name.
# Only looks up names via the project's global class registry. Raw paths
# (e.g. "res://evil.gd") are intentionally not accepted here to prevent
# arbitrary script instantiation from agent-supplied input.
func get_script_by_name(name_of_class: String) -> Script:
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)

    # Search for it in the global class registry if it's a class name
    var global_classes: Array = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")

    for global_class: Dictionary in global_classes:
        var found_name_of_class: String = global_class["class"]
        var found_path: String = global_class["path"]

        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script: Script = load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break

    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name. The result is Variant because it can be any Object,
# and the callers use it as a node or resource depending on the operation.
func instantiate_class(name_of_class: String) -> Variant:
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null

    var result: Variant = null
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)

    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script: Script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = script.new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null

    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

    return result

# Create a new scene with a specified root node type
func create_scene(params: Dictionary) -> void:
    print("Creating scene: " + params.scene_path)

    # Get project paths and log them for debugging
    var project_res_path: String = "res://"
    var project_user_path: String = "user://"
    var global_res_path: String = ProjectSettings.globalize_path(project_res_path)
    var global_user_path: String = ProjectSettings.globalize_path(project_user_path)

    if debug_mode:
        print("Project paths:")
        print("- res:// path: " + project_res_path)
        print("- user:// path: " + project_user_path)
        print("- Globalized res:// path: " + global_res_path)
        print("- Globalized user:// path: " + global_user_path)

        # Print some common environment variables for debugging
        print("Environment variables:")
        var env_vars: Array = ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]
        for env_var: String in env_vars:
            if OS.has_environment(env_var):
                print("  " + env_var + " = " + OS.get_environment(env_var))

    # Normalize the scene path
    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)

    # Convert resource path to an absolute path
    var absolute_scene_path: String = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)

    # Get the scene directory paths
    var scene_dir_res: String = full_scene_path.get_base_dir()
    var scene_dir_abs: String = absolute_scene_path.get_base_dir()
    if debug_mode:
        print("Scene directory (resource path): " + scene_dir_res)
        print("Scene directory (absolute path): " + scene_dir_abs)

    # Only do extensive testing in debug mode
    if debug_mode:
        # Try to create a simple test file in the project root to verify write access
        var initial_test_file_path: String = "res://godot_mcp_test_write.tmp"
        var initial_test_file: FileAccess = FileAccess.open(initial_test_file_path, FileAccess.WRITE)
        if initial_test_file:
            initial_test_file.store_string("Test write access")
            initial_test_file.close()
            print("Successfully wrote test file to project root: " + initial_test_file_path)

            # Verify the test file exists
            var initial_test_file_exists: bool = FileAccess.file_exists(initial_test_file_path)
            print("Test file exists check: " + str(initial_test_file_exists))

            # Clean up the test file
            if initial_test_file_exists:
                var remove_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(initial_test_file_path))
                print("Test file removal result: " + str(remove_error))
        else:
            var write_error: Error = FileAccess.get_open_error()
            printerr("Failed to write test file to project root: " + str(write_error))
            printerr("This indicates a serious permission issue with the project directory")

    # Use traditional if-else statement for better compatibility
    var root_node_type: String = "Node2D"  # Default value
    if params.has("root_node_type"):
        root_node_type = params.root_node_type
    if debug_mode:
        print("Root node type: " + root_node_type)

    # Create the root node
    var scene_root: Variant = instantiate_class(root_node_type)
    if not scene_root:
        printerr("Failed to instantiate node of type: " + root_node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        quit(1)

    scene_root.name = "root"
    if debug_mode:
        print("Root node created with name: " + scene_root.name)

    # Set the owner of the root node to itself (important for scene saving)
    scene_root.owner = scene_root

    # Pack the scene
    var packed_scene: PackedScene = PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        # Only do extensive testing in debug mode
        if debug_mode:
            # First, let's verify we can write to the project directory
            print("Testing write access to project directory...")
            var test_write_path: String = "res://test_write_access.tmp"
            var test_write_abs: String = ProjectSettings.globalize_path(test_write_path)
            var test_file: FileAccess = FileAccess.open(test_write_path, FileAccess.WRITE)

            if test_file:
                test_file.store_string("Write test")
                test_file.close()
                print("Successfully wrote test file to project directory")

                # Clean up test file
                if FileAccess.file_exists(test_write_path):
                    var remove_error: Error = DirAccess.remove_absolute(test_write_abs)
                    print("Test file removal result: " + str(remove_error))
            else:
                var write_error: Error = FileAccess.get_open_error()
                printerr("Failed to write test file to project directory: " + str(write_error))
                printerr("This may indicate permission issues with the project directory")
                # Continue anyway, as the scene directory might still be writable

        # Ensure the scene directory exists using DirAccess
        if debug_mode:
            print("Ensuring scene directory exists...")

        # Get the scene directory relative to res://
        var scene_dir_relative: String = scene_dir_res.substr(6)  # Remove "res://" prefix
        if debug_mode:
            print("Scene directory (relative to res://): " + scene_dir_relative)

        # Create the directory if needed
        if not scene_dir_relative.is_empty():
            # First check if it exists
            var dir_exists: bool = DirAccess.dir_exists_absolute(scene_dir_abs)
            if debug_mode:
                print("Directory exists check (absolute): " + str(dir_exists))

            if not dir_exists:
                if debug_mode:
                    print("Directory doesn't exist, creating: " + scene_dir_relative)

                # Try to create the directory using DirAccess
                var dir: DirAccess = DirAccess.open("res://")
                if dir == null:
                    var open_error: Error = DirAccess.get_open_error()
                    printerr("Failed to open res:// directory: " + str(open_error))

                    # Try alternative approach with absolute path
                    if debug_mode:
                        print("Trying alternative directory creation approach...")
                    var make_dir_error: Error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
                    if debug_mode:
                        print("Make directory result (absolute): " + str(make_dir_error))

                    if make_dir_error != OK:
                        printerr("Failed to create directory using absolute path")
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)
                else:
                    # Create the directory using the DirAccess instance
                    if debug_mode:
                        print("Creating directory using DirAccess: " + scene_dir_relative)
                    var make_dir_error: Error = dir.make_dir_recursive(scene_dir_relative)
                    if debug_mode:
                        print("Make directory result: " + str(make_dir_error))

                    if make_dir_error != OK:
                        printerr("Failed to create directory: " + scene_dir_relative)
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)

                # Verify the directory was created
                dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
                if debug_mode:
                    print("Directory exists check after creation: " + str(dir_exists))

                if not dir_exists:
                    printerr("Directory reported as created but does not exist: " + scene_dir_abs)
                    printerr("This may indicate a problem with path resolution or permissions")
                    quit(1)
            elif debug_mode:
                print("Directory already exists: " + scene_dir_abs)

        # Save the scene
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

        if save_error == OK:
            # Only do extensive testing in debug mode
            if debug_mode:
                # Wait a moment to ensure file system has time to complete the write
                print("Waiting for file system to complete write operation...")
                OS.delay_msec(500)  # 500ms delay

                # Verify the file was actually created using multiple methods
                var file_check_abs: bool = FileAccess.file_exists(absolute_scene_path)
                print("File exists check (absolute path): " + str(file_check_abs))

                var file_check_res: bool = FileAccess.file_exists(full_scene_path)
                print("File exists check (resource path): " + str(file_check_res))

                var res_exists: bool = ResourceLoader.exists(full_scene_path)
                print("Resource exists check: " + str(res_exists))

                # If file doesn't exist by absolute path, try to create a test file in the same directory
                if not file_check_abs and not file_check_res:
                    printerr("Scene file not found after save. Trying to diagnose the issue...")

                    # Try to write a test file to the same directory
                    var test_scene_file_path: String = scene_dir_res + "/test_scene_file.tmp"
                    var test_scene_file: FileAccess = FileAccess.open(test_scene_file_path, FileAccess.WRITE)

                    if test_scene_file:
                        test_scene_file.store_string("Test scene directory write")
                        test_scene_file.close()
                        print("Successfully wrote test file to scene directory: " + test_scene_file_path)

                        # Check if the test file exists
                        var test_file_exists: bool = FileAccess.file_exists(test_scene_file_path)
                        print("Test file exists: " + str(test_file_exists))

                        if test_file_exists:
                            # Directory is writable, so the issue is with scene saving
                            printerr("Directory is writable but scene file wasn't created.")
                            printerr("This suggests an issue with ResourceSaver.save() or the packed scene.")

                            # Try saving with a different approach
                            print("Trying alternative save approach...")
                            var alt_save_error: Error = ResourceSaver.save(packed_scene, test_scene_file_path + ".tscn")
                            print("Alternative save result: " + str(alt_save_error))

                            # Clean up test files
                            DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path))
                            if alt_save_error == OK:
                                DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path + ".tscn"))
                        else:
                            printerr("Test file couldn't be verified. This suggests filesystem access issues.")
                    else:
                        var write_error: Error = FileAccess.get_open_error()
                        printerr("Failed to write test file to scene directory: " + str(write_error))
                        printerr("This confirms there are permission or path issues with the scene directory.")

                    # Return error since we couldn't create the scene file
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)

                # If we get here, at least one of our file checks passed
                if file_check_abs or file_check_res or res_exists:
                    print("Scene file verified to exist!")

                    # Try to load the scene to verify it's valid
                    var test_load: Resource = ResourceLoader.load(full_scene_path)
                    if test_load:
                        print("Scene created and verified successfully at: " + params.scene_path)
                        print("Scene file can be loaded correctly.")
                    else:
                        print("Scene file exists but cannot be loaded. It may be corrupted or incomplete.")
                        # Continue anyway since the file exists

                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("All file existence checks failed despite successful save operation.")
                    printerr("This indicates a serious issue with file system access or path resolution.")
                    quit(1)
            else:
                # In non-debug mode, just check if the file exists
                var file_exists: bool = FileAccess.file_exists(full_scene_path)
                if file_exists:
                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)
        else:
            # Handle specific error codes
            var error_message: String = "Failed to save scene. Error code: " + str(save_error)

            if save_error == ERR_CANT_CREATE:
                error_message += " (ERR_CANT_CREATE - Cannot create the scene file)"
            elif save_error == ERR_CANT_OPEN:
                error_message += " (ERR_CANT_OPEN - Cannot open the scene file for writing)"
            elif save_error == ERR_FILE_CANT_WRITE:
                error_message += " (ERR_FILE_CANT_WRITE - Cannot write to the scene file)"
            elif save_error == ERR_FILE_NO_PERMISSION:
                error_message += " (ERR_FILE_NO_PERMISSION - No permission to write the scene file)"

            printerr(error_message)
            quit(1)
    else:
        printerr("Failed to pack scene: " + str(result))
        printerr("Error code: " + str(result))
        quit(1)

# Add a node to an existing scene
func add_node(params: Dictionary) -> void:
    print("Adding node to scene: " + params.scene_path)

    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)

    var absolute_scene_path: String = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)

    if not FileAccess.file_exists(absolute_scene_path):
        printerr("Failed to add node: scene file does not exist at: " + absolute_scene_path)
        quit(1)
        return

    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)

    if debug_mode:
        print("Scene loaded successfully")
    var scene_root: Node = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Use traditional if-else statement for better compatibility
    var parent_path: String = "root"  # Default value
    if params.has("parent_node_path"):
        parent_path = params.parent_node_path
    if debug_mode:
        print("Parent path: " + parent_path)

    # The path starts with the name of the scene root, or with "root" (the name create_scene gives it).
    var parent: Node = _find_node(scene_root, str(scene_root.name), parent_path)
    if parent == null:
        printerr("Failed to add node: parent node not found: " + parent_path)
        scene_root.free()
        quit(1)
        return
    if parent.get_node_or_null(str(params.node_name)) != null:
        printerr("Failed to add node: a node named " + str(params.node_name) + " already exists under " + parent_path)
        scene_root.free()
        quit(1)
        return
    if debug_mode:
        print("Parent node found: " + parent.name)

    if debug_mode:
        print("Instantiating node of type: " + params.node_type)
    var new_node: Variant = instantiate_class(params.node_type)
    if not new_node:
        printerr("Failed to instantiate node of type: " + params.node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        scene_root.free()
        quit(1)
        return
    new_node.name = params.node_name
    if debug_mode:
        print("New node created with name: " + new_node.name)

    if params.has("properties"):
        if debug_mode:
            print("Setting properties on node")
        var properties: Dictionary = params.properties
        var target: Object = new_node
        for property: String in properties:
            if debug_mode:
                print("Setting property: " + property + " = " + str(properties[property]))
            var expected_type: int = property_type_of(target, property)
            if expected_type == -1:
                printerr("Failed to add node: " + str(params.node_type) + " has no property " + property)
                target.free()
                scene_root.free()
                quit(1)
                return
            var converted: Dictionary = convert_property_value(expected_type, properties[property])
            if not converted.ok:
                printerr("Failed to add node: " + property + ": " + str(converted.error))
                target.free()
                scene_root.free()
                quit(1)
                return
            var value: Variant = converted.value
            target.set(property, value)
            if not values_match(target.get(property), value):
                printerr("Failed to add node: " + property + " did not take the value " + var_to_str(value))
                target.free()
                scene_root.free()
                quit(1)
                return

    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        print("Node added to parent and ownership set")

    var packed_scene: PackedScene = PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + absolute_scene_path)
        var save_error: Error = ResourceSaver.save(packed_scene, absolute_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(absolute_scene_path)
                print("File exists check after save: " + str(file_check_after))
                if file_check_after:
                    print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
                else:
                    printerr("File reported as saved but does not exist at: " + absolute_scene_path)
            else:
                print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
        else:
            printerr("Failed to save scene: " + str(save_error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Load a sprite into a Sprite2D node
func load_sprite(params: Dictionary) -> void:
    print("Loading sprite into scene: " + params.scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path: String = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)

    # Ensure the texture path starts with res:// for Godot's resource system
    var full_texture_path: String = params.texture_path
    if not full_texture_path.begins_with("res://"):
        full_texture_path = "res://" + full_texture_path

    if debug_mode:
        print("Full texture path (with res://): " + full_texture_path)

    # Load the scene
    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root: Node = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Find the sprite node
    var node_path: String = params.node_path
    if debug_mode:
        print("Original node path: " + node_path)

    # Typed as Variant: the sprite can be Sprite2D, Sprite3D or TextureRect, and the
    # texture property is set after the type check below.
    var sprite_node: Variant = null
    if node_path == "":
        # If no node path, assume root is the sprite
        sprite_node = scene_root
        if debug_mode:
            print("Using root node as sprite node")
    else:
        # The path starts with the name of the scene root, or with "root".
        sprite_node = _find_node(scene_root, str(scene_root.name), node_path)
        if sprite_node and debug_mode:
            print("Found sprite node: " + sprite_node.name)

    if not sprite_node:
        printerr("Node not found: " + params.node_path)
        quit(1)

    # Check if the node is a Sprite2D or compatible type
    if debug_mode:
        print("Node class: " + sprite_node.get_class())
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        printerr("Node is not a sprite-compatible type: " + sprite_node.get_class())
        quit(1)

    # Load the texture
    if debug_mode:
        print("Loading texture from: " + full_texture_path)
    var texture: Texture2D = load(full_texture_path)
    if not texture:
        printerr("Failed to load texture: " + full_texture_path)
        quit(1)

    if debug_mode:
        print("Texture loaded successfully")

    # Set the texture on the sprite
    if sprite_node is Sprite2D or sprite_node is Sprite3D:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is TextureRect:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on TextureRect node")

    # Save the modified scene
    var packed_scene: PackedScene = PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var error: Error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

        if error == OK:
            # Verify the file was actually updated
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(full_scene_path)
                print("File exists check after save: " + str(file_check_after))

                if file_check_after:
                    print("Sprite loaded successfully with texture: " + full_texture_path)
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(full_scene_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + full_scene_path)
            else:
                print("Sprite loaded successfully with texture: " + full_texture_path)
        else:
            printerr("Failed to save scene: " + str(error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Export a scene as a MeshLibrary resource
func export_mesh_library(params: Dictionary) -> void:
    print("Exporting MeshLibrary from scene: " + params.scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Ensure the output path starts with res:// for Godot's resource system
    var full_output_path: String = params.output_path
    if not full_output_path.begins_with("res://"):
        full_output_path = "res://" + full_output_path

    if debug_mode:
        print("Full output path (with res://): " + full_output_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path: String = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)

    # Load the scene
    if debug_mode:
        print("Loading scene from: " + full_scene_path)
    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root: Node = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Create a new MeshLibrary
    var mesh_library: MeshLibrary = MeshLibrary.new()
    if debug_mode:
        print("Created new MeshLibrary")

    # Get mesh item names if provided
    var mesh_item_names: Array = params.mesh_item_names if params.has("mesh_item_names") else []
    var use_specific_items: bool = mesh_item_names.size() > 0

    if debug_mode:
        if use_specific_items:
            print("Using specific mesh items: " + str(mesh_item_names))
        else:
            print("Using all mesh items in the scene")

    # Process all child nodes
    var item_id: int = 0
    if debug_mode:
        print("Processing child nodes...")

    for child: Node in scene_root.get_children():
        if debug_mode:
            print("Checking child node: " + child.name)

        # Skip if not using all items and this item is not in the list
        if use_specific_items and not (child.name in mesh_item_names):
            if debug_mode:
                print("Skipping node " + child.name + " (not in specified items list)")
            continue

        # Check if the child has a mesh
        var mesh_instance: MeshInstance3D = null
        if child is MeshInstance3D:
            mesh_instance = child as MeshInstance3D
            if debug_mode:
                print("Node " + child.name + " is a MeshInstance3D")
        else:
            # Try to find a MeshInstance3D in the child's descendants
            if debug_mode:
                print("Searching for MeshInstance3D in descendants of " + child.name)
            for descendant: Node in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant as MeshInstance3D
                    if debug_mode:
                        print("Found MeshInstance3D in descendant: " + descendant.name)
                    break

        if mesh_instance and mesh_instance.mesh:
            if debug_mode:
                print("Adding mesh: " + child.name)

            # Add the mesh to the library
            mesh_library.create_item(item_id)
            mesh_library.set_item_name(item_id, child.name)
            mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
            if debug_mode:
                print("Added mesh to library with ID: " + str(item_id))

            # Add collision shape if available
            var collision_added: bool = false
            for collision_child: Node in child.get_children():
                var collision_shape: CollisionShape3D = collision_child as CollisionShape3D
                if collision_shape and collision_shape.shape:
                    mesh_library.set_item_shapes(item_id, [collision_shape.shape])
                    if debug_mode:
                        print("Added collision shape from: " + collision_child.name)
                    collision_added = true
                    break

            if debug_mode and not collision_added:
                print("No collision shape found for mesh: " + child.name)

            # No preview is set: MeshLibrary.set_item_preview expects a Texture2D, and the
            # editor builds the item preview from the mesh itself.

            item_id += 1
        elif debug_mode:
            print("Node " + child.name + " has no valid mesh")

    if debug_mode:
        print("Processed " + str(item_id) + " meshes")

    # Create directory if it doesn't exist
    var dir: DirAccess = DirAccess.open("res://")
    if dir == null:
        printerr("Failed to open res:// directory")
        printerr("DirAccess error: " + str(DirAccess.get_open_error()))
        quit(1)

    var output_dir: String = full_output_path.get_base_dir()
    if debug_mode:
        print("Output directory: " + output_dir)

    if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
        if debug_mode:
            print("Creating directory: " + output_dir)
        var make_dir_error: Error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
        if make_dir_error != OK:
            printerr("Failed to create directory: " + output_dir + ", error: " + str(make_dir_error))
            quit(1)

    # Save the mesh library
    if item_id > 0:
        if debug_mode:
            print("Saving MeshLibrary to: " + full_output_path)
        var save_error: Error = ResourceSaver.save(mesh_library, full_output_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

        if save_error == OK:
            # Verify the file was actually created
            var file_created: bool = FileAccess.file_exists(full_output_path)
            if debug_mode:
                print("File exists check after save: " + str(file_created))

            if file_created:
                print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
                if debug_mode:
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(full_output_path)
                    print("Absolute file path: " + absolute_path)
            else:
                printerr("Failed to export MeshLibrary: file was not created at " + full_output_path)
                quit(1)
        else:
            printerr("Failed to save MeshLibrary: " + str(save_error))
            quit(1)
    else:
        # Exit with an error so the TypeScript side reports a failure
        printerr("Failed to export MeshLibrary: no valid meshes found in the scene")
        quit(1)

# Find files with a specific extension recursively
func find_files(path: String, extension: String) -> Array:
    var files: Array = []
    var dir: DirAccess = DirAccess.open(path)

    if dir:
        dir.list_dir_begin()
        var file_name: String = dir.get_next()

        while file_name != "":
            if dir.current_is_dir() and not file_name.begins_with("."):
                files.append_array(find_files(path + file_name + "/", extension))
            elif file_name.ends_with(extension):
                files.append(path + file_name)

            file_name = dir.get_next()

    return files

# Get UID for a specific file
func get_uid(params: Dictionary) -> void:
    if not params.has("file_path"):
        printerr("File path is required")
        quit(1)

    # Ensure the file path starts with res:// for Godot's resource system
    var file_path: String = params.file_path
    if not file_path.begins_with("res://"):
        file_path = "res://" + file_path

    print("Getting UID for file: " + file_path)
    if debug_mode:
        print("Full file path (with res://): " + file_path)

    # Get the absolute path for reference
    var absolute_path: String = ProjectSettings.globalize_path(file_path)
    if debug_mode:
        print("Absolute file path: " + absolute_path)

    # Ensure the file exists
    var file_check: bool = FileAccess.file_exists(file_path)
    if debug_mode:
        print("File exists check: " + str(file_check))

    if not file_check:
        printerr("File does not exist at: " + file_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)

    # Check if the UID file exists
    var uid_path: String = file_path + ".uid"
    if debug_mode:
        print("UID file path: " + uid_path)

    var uid_check: bool = FileAccess.file_exists(uid_path)
    if debug_mode:
        print("UID file exists check: " + str(uid_check))

    var f: FileAccess = FileAccess.open(uid_path, FileAccess.READ)

    if f:
        # Read the UID content
        var uid_content: String = f.get_as_text()
        f.close()
        if debug_mode:
            print("UID content read successfully")

        # Return the UID content
        var result: Dictionary = {
            "file": file_path,
            "absolutePath": absolute_path,
            "uid": uid_content.strip_edges(),
            "exists": true
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))
    else:
        if debug_mode:
            print("UID file does not exist or could not be opened")

        # UID file doesn't exist
        var result: Dictionary = {
            "file": file_path,
            "absolutePath": absolute_path,
            "exists": false,
            "message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))

# Resave all resources to update UID references
func resave_resources(params: Dictionary) -> void:
    print("Resaving all resources to update UID references...")

    # Get project path if provided
    var project_path: String = "res://"
    # Only a path inside the project is used; an absolute path would be read as a folder in the project.
    if params.has("project_path") and (str(params.project_path).begins_with("res://") or not str(params.project_path).is_absolute_path()):
        project_path = params.project_path
        if not project_path.begins_with("res://"):
            project_path = "res://" + project_path
        if not project_path.ends_with("/"):
            project_path += "/"

    if debug_mode:
        print("Using project path: " + project_path)

    # Get all .tscn files
    if debug_mode:
        print("Searching for scene files in: " + project_path)
    var scenes: Array = find_files(project_path, ".tscn")
    if debug_mode:
        print("Found " + str(scenes.size()) + " scenes")

    # Resave each scene
    var success_count: int = 0
    var error_count: int = 0

    for scene_path: String in scenes:
        if debug_mode:
            print("Processing scene: " + scene_path)

        # Check if the scene file exists
        var file_check: bool = FileAccess.file_exists(scene_path)
        if debug_mode:
            print("Scene file exists check: " + str(file_check))

        if not file_check:
            printerr("Scene file does not exist at: " + scene_path)
            error_count += 1
            continue

        # Load the scene
        var scene: Resource = load(scene_path)
        if scene:
            if debug_mode:
                print("Scene loaded successfully, saving...")
            var save_error: Error = ResourceSaver.save(scene, scene_path)
            if debug_mode:
                print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

            if save_error == OK:
                success_count += 1
                if debug_mode:
                    print("Scene saved successfully: " + scene_path)

                    # Verify the file was actually updated
                    var file_check_after: bool = FileAccess.file_exists(scene_path)
                    print("File exists check after save: " + str(file_check_after))

                    if not file_check_after:
                        printerr("File reported as saved but does not exist at: " + scene_path)
            else:
                error_count += 1
                printerr("Failed to save: " + scene_path + ", error: " + str(save_error))
        else:
            error_count += 1
            printerr("Failed to load: " + scene_path)

    # Get all .gd and .shader files
    if debug_mode:
        print("Searching for script and shader files in: " + project_path)
    var scripts: Array = find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
    if debug_mode:
        print("Found " + str(scripts.size()) + " scripts/shaders")

    # Check for missing .uid files
    var missing_uids: int = 0
    var generated_uids: int = 0

    for script_path: String in scripts:
        if debug_mode:
            print("Checking UID for: " + script_path)
        var uid_path: String = script_path + ".uid"

        var uid_check: bool = FileAccess.file_exists(uid_path)
        if debug_mode:
            print("UID file exists check: " + str(uid_check))

        var f: FileAccess = FileAccess.open(uid_path, FileAccess.READ)
        if not f:
            missing_uids += 1
            if debug_mode:
                print("Missing UID file for: " + script_path + ", generating...")

            # Force a save to generate UID
            var res: Resource = load(script_path)
            if res:
                var save_error: Error = ResourceSaver.save(res, script_path)
                if debug_mode:
                    print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

                if save_error == OK:
                    generated_uids += 1
                    if debug_mode:
                        print("Generated UID for: " + script_path)

                        # Verify the UID file was actually created
                        var uid_check_after: bool = FileAccess.file_exists(uid_path)
                        print("UID file exists check after save: " + str(uid_check_after))

                        if not uid_check_after:
                            printerr("UID file reported as generated but does not exist at: " + uid_path)
                else:
                    printerr("Failed to generate UID for: " + script_path + ", error: " + str(save_error))
            else:
                printerr("Failed to load resource: " + script_path)
        elif debug_mode:
            print("UID file already exists for: " + script_path)

    if debug_mode:
        print("Summary:")
        print("- Scenes processed: " + str(scenes.size()))
        print("- Scenes successfully saved: " + str(success_count))
        print("- Scenes with errors: " + str(error_count))
        print("- Scripts/shaders missing UIDs: " + str(missing_uids))
        print("- UIDs successfully generated: " + str(generated_uids))
    print("Resave operation complete")

# Type of a property on a node, or -1 when the node has no such property.
func property_type_of(node: Object, property_name: String) -> int:
    for info: Dictionary in node.get_property_list():
        if str(info.name) == property_name:
            return int(info.type)
    return -1

# Turns the value given for a property into the value that property takes. A string for a
# Resource property is a res:// path, and text for a String property stays as text. Any other
# text is a Godot literal, parsed with str_to_var(). Returns {ok, value, error}.
func convert_property_value(expected_type: int, value: Variant) -> Dictionary:
    if typeof(value) == TYPE_DICTIONARY:
        return convert_json_object(expected_type, value)
    if typeof(value) != TYPE_STRING:
        return {"ok": true, "value": value, "error": ""}
    var text: String = value
    var parsed: Variant = str_to_var(text)
    var result: Variant = text
    if parsed != null:
        # A quoted text such as "res://a.tres" parses to a string; other literals parse to their value.
        if typeof(parsed) == TYPE_STRING:
            result = parsed
        elif expected_type != TYPE_STRING:
            result = parsed
    elif text.strip_edges() == "null":
        result = null
    elif expected_type != TYPE_STRING and not text.begins_with("res://"):
        return {"ok": false, "value": null, "error": "value is not a valid Godot literal: " + text}
    if expected_type == TYPE_OBJECT and typeof(result) == TYPE_STRING:
        var path: String = result
        if path.begins_with("res://"):
            result = load(path)
            if result == null:
                return {"ok": false, "value": null, "error": "could not load " + path}
    return {"ok": true, "value": result, "error": ""}

# A JSON object such as {"x": 10, "y": 20} sets a Vector2, Vector3 or Color property, and a
# JSON object sets a Dictionary property as it is.
func convert_json_object(expected_type: int, value: Variant) -> Dictionary:
    var fields: Dictionary = value
    if expected_type == TYPE_VECTOR2 and fields.has("x") and fields.has("y"):
        return {"ok": true, "value": Vector2(float(fields.x), float(fields.y)), "error": ""}
    if expected_type == TYPE_VECTOR3 and fields.has("x") and fields.has("y") and fields.has("z"):
        return {"ok": true, "value": Vector3(float(fields.x), float(fields.y), float(fields.z)), "error": ""}
    if expected_type == TYPE_COLOR and fields.has("r") and fields.has("g") and fields.has("b"):
        return {"ok": true, "value": Color(float(fields.r), float(fields.g), float(fields.b), float(fields.get("a", 1.0))), "error": ""}
    if expected_type == TYPE_DICTIONARY:
        return {"ok": true, "value": fields, "error": ""}
    return {"ok": false, "value": null, "error": "a JSON object only sets a Vector2, Vector3, Color or Dictionary property"}

# True when a property reports the value that was set. Numbers and vectors are compared with a small
# tolerance, because Godot stores rotations and scales as matrices and reads them back with rounding.
# Values of different types never match, so the comparison never mixes them.
func values_match(actual: Variant, expected: Variant) -> bool:
    var expected_kind: int = typeof(expected)
    var actual_kind: int = typeof(actual)
    if expected_kind == TYPE_FLOAT or expected_kind == TYPE_INT:
        return (actual_kind == TYPE_FLOAT or actual_kind == TYPE_INT) and absf(float(actual) - float(expected)) < 0.0001
    # Godot reads some String properties back as a StringName.
    var texts: Array = [TYPE_STRING, TYPE_STRING_NAME]
    if texts.has(expected_kind) and texts.has(actual_kind):
        return str(actual) == str(expected)
    if actual_kind != expected_kind:
        return false
    if expected_kind == TYPE_VECTOR2:
        return (actual as Vector2).is_equal_approx(expected as Vector2)
    if expected_kind == TYPE_VECTOR3:
        return (actual as Vector3).is_equal_approx(expected as Vector3)
    if expected_kind == TYPE_COLOR:
        return (actual as Color).is_equal_approx(expected as Color)
    return actual == expected

# Set one property on a node of an existing scene. The value is a Godot literal,
# such as 42, true, "text", or Vector2(1, 2), parsed with str_to_var().
# node_path is written like "root/Player"; its first segment is the scene root.
func set_node_property(params: Dictionary) -> void:
    print("Setting property on scene: " + params.scene_path)

    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if not FileAccess.file_exists(full_scene_path):
        printerr("Failed to set property: scene file does not exist at " + full_scene_path)
        quit(1)
        return

    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to set property: could not load scene " + full_scene_path)
        quit(1)
        return

    var scene_root: Node = scene.instantiate()
    var node_path: String = params.node_path
    var root_name: String = str(scene_root.name)
    var relative_path: String = node_path
    if node_path == root_name:
        relative_path = "."
    elif node_path.begins_with(root_name + "/"):
        relative_path = node_path.substr(root_name.length() + 1)

    var node: Node = scene_root if relative_path == "." else scene_root.get_node_or_null(relative_path)
    if node == null:
        printerr("Failed to set property: node not found: " + node_path)
        scene_root.free()
        quit(1)
        return

    var property_name: String = params.property
    var has_property: bool = false
    for info: Dictionary in node.get_property_list():
        if str(info.name) == property_name:
            has_property = true
            break
    if not has_property:
        printerr("Failed to set property: node " + node_path + " has no property " + property_name)
        scene_root.free()
        quit(1)
        return

    var converted: Dictionary = convert_property_value(property_type_of(node, property_name), str(params.value))
    if not converted.ok:
        printerr("Failed to set property: " + str(converted.error))
        scene_root.free()
        quit(1)
        return

    var value: Variant = converted.value
    node.set(property_name, value)
    var actual: Variant = node.get(property_name)
    if not values_match(actual, value):
        printerr("Failed to set property: " + property_name + " did not take the value " + var_to_str(value) + " (it is " + var_to_str(actual) + ")")
        scene_root.free()
        quit(1)
        return

    var packed_scene: PackedScene = PackedScene.new()
    var pack_result: Error = packed_scene.pack(scene_root)
    if pack_result != OK:
        printerr("Failed to set property: could not pack scene, error " + str(pack_result))
        scene_root.free()
        quit(1)
        return

    var save_error: Error = ResourceSaver.save(packed_scene, full_scene_path)
    scene_root.free()
    if save_error != OK:
        printerr("Failed to set property: could not save scene, error " + str(save_error))
        quit(1)
        return

    print("Property " + property_name + " set on " + node_path + " in " + full_scene_path)

# Save changes to a scene file
# Read-only checks used around text edits of scenes that inherit from another scene. The
# scene is loaded and instantiated, nothing is saved. Prints one line per result:
#   VALUE <literal>      current value of params.property on the node
#   EXPECTED <literal>   params.value parsed as a Godot literal (same format as VALUE)
#   HAS_VALUE 1|0        whether params.property is set (with check_has_value)
#   IS_SPRITE 1|0        whether the node is Sprite2D, Sprite3D or TextureRect (with check_sprite)
# and INSPECT_OK when every requested check passes. A failed check prints
# "Failed to inspect: ..." and exits with an error.
func inspect_node(params: Dictionary) -> void:
    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to inspect: could not load scene " + full_scene_path)
        quit(1)
        return

    var scene_root: Node = scene.instantiate()
    var root_name: String = str(scene_root.name)

    var node: Node = null
    if params.has("node_path"):
        node = _find_node(scene_root, root_name, str(params.node_path))
        if node == null:
            printerr("Failed to inspect: node not found: " + str(params.node_path))
            scene_root.free()
            quit(1)
            return

    if params.has("parent_node_path"):
        var parent: Node = _find_node(scene_root, root_name, str(params.parent_node_path))
        if parent == null:
            printerr("Failed to inspect: parent node not found: " + str(params.parent_node_path))
            scene_root.free()
            quit(1)
            return
        if parent.get_node_or_null(str(params.node_name)) != null:
            printerr("Failed to inspect: a node named " + str(params.node_name) + " already exists under " + str(params.parent_node_path))
            scene_root.free()
            quit(1)
            return

    if params.has("node_type"):
        var node_type: String = str(params.node_type)
        if not ClassDB.class_exists(node_type) or not ClassDB.can_instantiate(node_type):
            printerr("Failed to inspect: node type must be a built-in class that can be instantiated: " + node_type)
            scene_root.free()
            quit(1)
            return

    if params.has("property") and node != null:
        var property_name: String = str(params.property)
        if not _has_property(node, property_name):
            printerr("Failed to inspect: node " + str(params.node_path) + " has no property " + property_name)
            scene_root.free()
            quit(1)
            return
        if params.has("value"):
            var expected: Variant = str_to_var(str(params.value))
            if expected == null and str(params.value).strip_edges() != "null":
                printerr("Failed to inspect: value is not a valid Godot literal: " + str(params.value))
                scene_root.free()
                quit(1)
                return
            print("EXPECTED " + var_to_str(expected))
        if params.has("apply_in_memory") and params.has("value"):
            # Apply the value to the in-memory node only. Godot then computes the derived
            # transform (position, rotation and scale all live in it), which is printed so the
            # caller can write it to the scene file. Nothing is saved here.
            node.set(property_name, str_to_var(str(params.value)))
            if _has_property(node, "transform"):
                print("TRANSFORM " + var_to_str(node.get("transform")))
        var current: Variant = node.get(property_name)
        print("VALUE " + var_to_str(current))
        if params.has("check_has_value"):
            print("HAS_VALUE " + ("1" if current != null else "0"))

    if params.has("check_sprite") and node != null:
        var is_sprite: bool = node is Sprite2D or node is Sprite3D or node is TextureRect
        print("IS_SPRITE " + ("1" if is_sprite else "0"))

    scene_root.free()
    print("INSPECT_OK")

# Find a node from a path that starts with the root name (for example "root/Player").
# "root" also names the root, because create_scene calls it that and older calls use it.
func _find_node(scene_root: Node, root_name: String, node_path: String) -> Node:
    var relative_path: String = node_path
    if node_path == root_name:
        relative_path = "."
    elif node_path.begins_with(root_name + "/"):
        relative_path = node_path.substr(root_name.length() + 1)
    elif node_path == "root" and scene_root.get_node_or_null("root") == null:
        relative_path = "."
    elif node_path.begins_with("root/") and scene_root.get_node_or_null("root") == null:
        relative_path = node_path.substr(5)
    return scene_root if relative_path == "." else scene_root.get_node_or_null(relative_path)

func _has_property(node: Object, property_name: String) -> bool:
    for info: Dictionary in node.get_property_list():
        if str(info.name) == property_name:
            return true
    return false

func save_scene(params: Dictionary) -> void:
    print("Saving scene: " + params.scene_path)

    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path: String = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path

    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)

    # Check if the scene file exists
    var file_check: bool = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))

    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path: String = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)

    # Load the scene
    var scene: PackedScene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)

    if debug_mode:
        print("Scene loaded successfully")

    # Instance the scene
    var scene_root: Node = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")

    # Determine save path
    var save_path: String = params.new_path if params.has("new_path") else full_scene_path
    if params.has("new_path") and not save_path.begins_with("res://"):
        save_path = "res://" + save_path

    if debug_mode:
        print("Save path: " + save_path)

    # Create directory if it doesn't exist
    if params.has("new_path"):
        var dir: DirAccess = DirAccess.open("res://")
        if dir == null:
            printerr("Failed to open res:// directory")
            printerr("DirAccess error: " + str(DirAccess.get_open_error()))
            quit(1)

        var scene_dir: String = save_path.get_base_dir()
        if debug_mode:
            print("Scene directory: " + scene_dir)

        if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):  # Remove "res://" prefix
            if debug_mode:
                print("Creating directory: " + scene_dir)
            var make_dir_error: Error = dir.make_dir_recursive(scene_dir.substr(6))  # Remove "res://" prefix
            if make_dir_error != OK:
                printerr("Failed to create directory: " + scene_dir + ", error: " + str(make_dir_error))
                quit(1)

    # Create a packed scene
    var packed_scene: PackedScene = PackedScene.new()
    var result: Error = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            print("Saving scene to: " + save_path)
        var save_error: Error = ResourceSaver.save(packed_scene, save_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

        if save_error == OK:
            # Verify the file was actually created/updated
            if debug_mode:
                var file_check_after: bool = FileAccess.file_exists(save_path)
                print("File exists check after save: " + str(file_check_after))

                if file_check_after:
                    print("Scene saved successfully to: " + save_path)
                    # Get the absolute path for reference
                    var absolute_path: String = ProjectSettings.globalize_path(save_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + save_path)
            else:
                print("Scene saved successfully to: " + save_path)
        else:
            printerr("Failed to save scene: " + str(save_error))
    else:
        printerr("Failed to pack scene: " + str(result))


# ---------------------------------------------------------------------------
# 2D tools: import_spritesheet, auto_collision, build_tilemap, setup_parallax_2d.
# Each prints "RESULT <json>" when it succeeds, and "Failed to ..." on stderr otherwise.
# ---------------------------------------------------------------------------

func _res_path(path: String) -> String:
    return path if path.begins_with("res://") else "res://" + path

# Reports a failure. quit() does not stop the script, so callers return right after this.
func _fail(message: String) -> void:
    _failed = true
    printerr("Failed to " + message)
    quit(1)

func _run_bake_navmesh() -> void:
    bake_navmesh(_deferred_params)
    if not _failed:
        quit()

func _result(data: Dictionary) -> void:
    print("RESULT " + JSON.stringify(data))

# Loads and instantiates a scene to edit. Returns null after reporting the failure.
func _open_scene_root(scene_path: String, what: String) -> Node:
    var full_path: String = _res_path(scene_path)
    if not FileAccess.file_exists(full_path):
        _fail(what + ": scene file does not exist at " + full_path)
        return null
    var packed: PackedScene = load(full_path) as PackedScene
    if packed == null:
        _fail(what + ": could not load scene " + full_path)
        return null
    return packed.instantiate()

func _save_scene_root(scene_root: Node, scene_path: String, what: String) -> bool:
    var packed: PackedScene = PackedScene.new()
    var pack_result: Error = packed.pack(scene_root)
    if pack_result != OK:
        _fail(what + ": could not pack the scene, error " + str(pack_result))
        return false
    var save_error: Error = ResourceSaver.save(packed, _res_path(scene_path))
    if save_error != OK:
        _fail(what + ": could not save the scene, error " + str(save_error))
        return false
    return true

func _make_parent_dir(res_file: String) -> void:
    DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(res_file.get_base_dir()))

# Parent node for new nodes: parent_node_path, or the scene root.
func _resolve_parent(scene_root: Node, params: Dictionary) -> Node:
    var parent_path: String = str(params.parent_node_path) if params.has("parent_node_path") else str(scene_root.name)
    return _find_node(scene_root, str(scene_root.name), parent_path)

@warning_ignore("integer_division")
func import_spritesheet(params: Dictionary) -> void:
    var what: String = "import spritesheet"
    var texture_path: String = _res_path(str(params.texture_path))
    var output_path: String = _res_path(str(params.output_path))
    var texture: Texture2D = load(texture_path) as Texture2D
    if texture == null:
        _fail(what + ": could not load texture " + texture_path)
        return

    var sheet_size: Vector2i = Vector2i(texture.get_width(), texture.get_height())
    var cell: Vector2i = Vector2i.ZERO
    if params.has("frame_width") and params.has("frame_height"):
        cell = Vector2i(int(params.frame_width), int(params.frame_height))
    elif params.has("columns") and params.has("rows"):
        var columns: int = int(params.columns)
        var rows: int = int(params.rows)
        if columns > 0 and rows > 0:
            cell = Vector2i(sheet_size.x / columns, sheet_size.y / rows)
    if cell.x <= 0 or cell.y <= 0 or cell.x > sheet_size.x or cell.y > sheet_size.y:
        _fail(what + ": the frame size " + str(cell) + " does not fit the texture " + str(sheet_size))
        return
    var grid: Vector2i = Vector2i(sheet_size.x / cell.x, sheet_size.y / cell.y)
    var total_frames: int = grid.x * grid.y

    var animations: Array = []
    if params.has("animations") and params.animations is Array and not (params.animations as Array).is_empty():
        animations = params.animations
    else:
        animations = [{"name": "default", "start": 0, "count": total_frames}]

    var frames: SpriteFrames = SpriteFrames.new()
    if frames.has_animation("default"):
        frames.remove_animation("default")

    var summary: Array = []
    for entry: Variant in animations:
        var animation: Dictionary = entry as Dictionary
        var anim_name: String = str(animation.get("name", ""))
        if anim_name == "" or frames.has_animation(anim_name):
            _fail(what + ": each animation needs its own name; got '" + anim_name + "'")
            return
        var start: int = int(animation.get("start", 0))
        var count: int = int(animation.get("count", grid.x))
        if animation.has("row"):
            start = int(animation.row) * grid.x
        if start < 0 or count <= 0 or start + count > total_frames:
            _fail(what + ": animation '" + anim_name + "' uses frames " + str(start) + " to " + str(start + count - 1) + ", but the sheet has " + str(total_frames))
            return
        frames.add_animation(anim_name)
        frames.set_animation_speed(anim_name, float(animation.get("fps", 10.0)))
        frames.set_animation_loop(anim_name, bool(animation.get("loop", true)))
        for index: int in range(start, start + count):
            var atlas: AtlasTexture = AtlasTexture.new()
            atlas.atlas = texture
            atlas.region = Rect2(Vector2((index % grid.x) * cell.x, (index / grid.x) * cell.y), Vector2(cell))
            frames.add_frame(anim_name, atlas)
        summary.append({"name": anim_name, "frames": count})

    _make_parent_dir(output_path)
    var save_error: Error = ResourceSaver.save(frames, output_path)
    if save_error != OK:
        _fail(what + ": could not save " + output_path + ", error " + str(save_error))
        return

    var node_path: String = ""
    if params.has("scene_path"):
        var scene_root: Node = _open_scene_root(str(params.scene_path), what)
        if scene_root == null:
            return
        var parent: Node = _resolve_parent(scene_root, params)
        if parent == null:
            _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
            scene_root.free()
            return
        var node_name: String = str(params.get("node_name", "AnimatedSprite2D"))
        if parent.get_node_or_null(node_name) != null:
            _fail(what + ": a node named " + node_name + " already exists under the parent")
            scene_root.free()
            return
        var sprite: AnimatedSprite2D = AnimatedSprite2D.new()
        sprite.name = node_name
        # Load the saved file so the scene points to it, instead of embedding a copy.
        sprite.sprite_frames = ResourceLoader.load(output_path, "SpriteFrames", ResourceLoader.CACHE_MODE_REPLACE) as SpriteFrames
        var first_name: String = str((summary[0] as Dictionary).name)
        sprite.animation = first_name
        sprite.autoplay = first_name
        parent.add_child(sprite)
        sprite.owner = scene_root
        if not _save_scene_root(scene_root, str(params.scene_path), what):
            scene_root.free()
            return
        node_path = str(scene_root.name) + "/" + str(scene_root.get_path_to(sprite))
        scene_root.free()

    _result({"output": output_path, "frame_size": [cell.x, cell.y], "grid": [grid.x, grid.y], "total_frames": total_frames, "animations": summary, "node": node_path})

func _polygon_area(points: PackedVector2Array) -> float:
    var area: float = 0.0
    for i: int in range(points.size()):
        var next: Vector2 = points[(i + 1) % points.size()]
        area += points[i].x * next.y - next.x * points[i].y
    return absf(area) / 2.0

# Builds collision or occluder polygons from the opaque part of a Sprite2D's texture.
@warning_ignore("integer_division")
func auto_collision(params: Dictionary) -> void:
    var what: String = "add collision"
    var scene_root: Node = _open_scene_root(str(params.scene_path), what)
    if scene_root == null:
        return
    var sprite: Sprite2D = _find_node(scene_root, str(scene_root.name), str(params.node_path)) as Sprite2D
    if sprite == null:
        _fail(what + ": " + str(params.node_path) + " is not a Sprite2D in the scene")
        scene_root.free()
        return
    if sprite.texture == null:
        _fail(what + ": the sprite has no texture")
        scene_root.free()
        return

    var image: Image = sprite.texture.get_image()
    if image == null:
        _fail(what + ": could not read the pixels of the texture")
        scene_root.free()
        return
    if image.is_compressed():
        image.decompress()
    image.convert(Image.FORMAT_RGBA8)

    # The part of the texture the sprite shows: its region, and the current frame of a sprite sheet.
    var rect: Rect2i = Rect2i(Vector2i.ZERO, image.get_size())
    if sprite.region_enabled:
        rect = Rect2i(sprite.region_rect).intersection(rect)
    if sprite.hframes > 1 or sprite.vframes > 1:
        var cell: Vector2i = Vector2i(rect.size.x / sprite.hframes, rect.size.y / sprite.vframes)
        rect = Rect2i(rect.position + Vector2i(sprite.frame_coords.x * cell.x, sprite.frame_coords.y * cell.y), cell)
    if rect.size.x <= 0 or rect.size.y <= 0:
        _fail(what + ": the visible part of the texture is empty")
        scene_root.free()
        return

    var bitmap: BitMap = BitMap.new()
    bitmap.create_from_image_alpha(image, float(params.get("alpha_threshold", 0.1)))
    var polygons: Array = bitmap.opaque_to_polygons(rect, float(params.get("epsilon", 2.0)))

    var kind: String = str(params.get("kind", "collision"))
    var min_area: float = float(params.get("min_area", 16.0))
    var target: Node = sprite.get_parent() if sprite.get_parent() != null else sprite
    if params.has("target_path"):
        target = _find_node(scene_root, str(scene_root.name), str(params.target_path))
    if target == null or (target != sprite and target != sprite.get_parent()):
        _fail(what + ": target_path must be the sprite itself or its parent")
        scene_root.free()
        return
    if kind == "collision" and not (target is CollisionObject2D):
        _fail(what + ": the target must be a CollisionObject2D such as StaticBody2D or Area2D; it is " + target.get_class())
        scene_root.free()
        return

    # Points are in texture pixels. Turn them into the sprite's local space, then into the target's.
    var origin: Vector2 = sprite.offset
    if sprite.centered:
        origin -= Vector2(rect.size) / 2.0
    var to_target: Transform2D = Transform2D.IDENTITY if target == sprite else sprite.transform

    var kept: Array = []
    for polygon: Variant in polygons:
        var source: PackedVector2Array = polygon as PackedVector2Array
        if source.size() < 3:
            continue
        var points: PackedVector2Array = PackedVector2Array()
        for point: Vector2 in source:
            # opaque_to_polygons gives points relative to the top left corner of rect.
            points.append(to_target * (point + origin))
        if _polygon_area(points) >= min_area:
            kept.append(points)
    if kept.is_empty():
        _fail(what + ": no opaque area of at least " + str(min_area) + " px found; lower min_area or alpha_threshold")
        scene_root.free()
        return

    var base_name: String = str(sprite.name) + ("Occluder" if kind == "occluder" else "Collision")
    var names: Array = []
    for i: int in range(kept.size()):
        names.append(base_name if i == 0 else base_name + str(i + 1))
    for existing_name: String in names:
        var existing: Node = target.get_node_or_null(existing_name)
        if existing != null:
            if bool(params.get("replace", false)):
                target.remove_child(existing)
                existing.free()
            else:
                _fail(what + ": " + existing_name + " already exists under " + str(target.name) + "; pass replace to overwrite it")
                scene_root.free()
                return

    for i: int in range(kept.size()):
        var created: Node2D = null
        if kind == "occluder":
            var occluder: LightOccluder2D = LightOccluder2D.new()
            var shape: OccluderPolygon2D = OccluderPolygon2D.new()
            shape.polygon = kept[i]
            occluder.occluder = shape
            created = occluder
        else:
            var collision: CollisionPolygon2D = CollisionPolygon2D.new()
            collision.polygon = kept[i]
            created = collision
        created.name = names[i]
        target.add_child(created)
        created.owner = scene_root

    if not _save_scene_root(scene_root, str(params.scene_path), what):
        scene_root.free()
        return
    scene_root.free()
    _result({"kind": kind, "polygons": kept.size(), "nodes": names, "texture_rect": [rect.position.x, rect.position.y, rect.size.x, rect.size.y]})

# Paints a TileMapLayer from rows of text. legend is a list of {char, x, y}: the atlas cell of each character.
func build_tilemap(params: Dictionary) -> void:
    var what: String = "build tilemap"
    if not ClassDB.class_exists("TileMapLayer"):
        _fail(what + ": TileMapLayer needs Godot 4.3 or later")
        return
    var scene_root: Node = _open_scene_root(str(params.scene_path), what)
    if scene_root == null:
        return

    var parent: Node = _resolve_parent(scene_root, params)
    if parent == null:
        _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
        scene_root.free()
        return
    var layer_name: String = str(params.get("node_name", "TileMapLayer"))
    if parent.get_node_or_null(layer_name) != null:
        _fail(what + ": a node named " + layer_name + " already exists under the parent")
        scene_root.free()
        return

    var cells: Dictionary = {}
    for entry: Variant in params.legend:
        var item: Dictionary = entry as Dictionary
        cells[str(item.get("char", ""))] = Vector2i(int(item.get("x", 0)), int(item.get("y", 0)))

    var tile_size: int = int(params.get("tile_size", 16))
    var tile_set_path: String = _res_path(str(params.tile_set_path)) if params.has("tile_set_path") else ""
    var tile_set: TileSet = null
    var changed: bool = false
    if tile_set_path != "" and ResourceLoader.exists(tile_set_path):
        tile_set = ResourceLoader.load(tile_set_path, "TileSet", ResourceLoader.CACHE_MODE_REPLACE) as TileSet
    if tile_set == null:
        if not params.has("texture_path"):
            _fail(what + ": pass texture_path to create a TileSet, or a tile_set_path that exists")
            scene_root.free()
            return
        var texture: Texture2D = load(_res_path(str(params.texture_path))) as Texture2D
        if texture == null:
            _fail(what + ": could not load texture " + str(params.texture_path))
            scene_root.free()
            return
        tile_set = TileSet.new()
        tile_set.tile_size = Vector2i(tile_size, tile_size)
        var new_source: TileSetAtlasSource = TileSetAtlasSource.new()
        new_source.texture = texture
        new_source.texture_region_size = Vector2i(tile_size, tile_size)
        tile_set.add_source(new_source, 0)
        changed = true
    if tile_set.get_source_count() == 0:
        _fail(what + ": the TileSet has no atlas source")
        scene_root.free()
        return
    var source_id: int = tile_set.get_source_id(0)
    var source: TileSetAtlasSource = tile_set.get_source(source_id) as TileSetAtlasSource
    if source == null:
        _fail(what + ": the first source of the TileSet is not an atlas")
        scene_root.free()
        return

    # Every character of the legend needs its tile in the atlas.
    var grid_size: Vector2i = source.get_atlas_grid_size()
    for key: Variant in cells:
        var coords: Vector2i = cells[key]
        if coords.x < 0 or coords.y < 0 or coords.x >= grid_size.x or coords.y >= grid_size.y:
            _fail(what + ": '" + str(key) + "' points to atlas cell " + str(coords) + ", but the atlas is " + str(grid_size) + " cells")
            scene_root.free()
            return
        if not source.has_tile(coords):
            source.create_tile(coords)
            changed = true
    if changed and tile_set_path != "":
        _make_parent_dir(tile_set_path)
        var tile_set_error: Error = ResourceSaver.save(tile_set, tile_set_path)
        if tile_set_error != OK:
            _fail(what + ": could not save " + tile_set_path + ", error " + str(tile_set_error))
            scene_root.free()
            return
        tile_set = ResourceLoader.load(tile_set_path, "TileSet", ResourceLoader.CACHE_MODE_REPLACE) as TileSet

    var layer: TileMapLayer = TileMapLayer.new()
    layer.name = layer_name
    layer.tile_set = tile_set
    var origin: Vector2i = Vector2i(int(params.get("origin_x", 0)), int(params.get("origin_y", 0)))
    var painted: int = 0
    var rows: Array = params.rows
    for y: int in range(rows.size()):
        var row: String = str(rows[y])
        for x: int in range(row.length()):
            var character: String = row[x]
            if character == "." or character == " ":
                continue
            if not cells.has(character):
                _fail(what + ": the character '" + character + "' (row " + str(y) + ", column " + str(x) + ") is not in the legend")
                layer.free()
                scene_root.free()
                return
            layer.set_cell(origin + Vector2i(x, y), source_id, cells[character])
            painted += 1

    parent.add_child(layer)
    layer.owner = scene_root
    if not _save_scene_root(scene_root, str(params.scene_path), what):
        scene_root.free()
        return
    scene_root.free()
    _result({"node": layer_name, "cells": painted, "tile_set": tile_set_path, "source_id": source_id})

# Adds one Parallax2D node per layer, each with a Sprite2D child that shows the layer's texture.
func setup_parallax_2d(params: Dictionary) -> void:
    var what: String = "set up parallax"
    if not ClassDB.class_exists("Parallax2D"):
        _fail(what + ": Parallax2D needs Godot 4.3 or later")
        return
    var scene_root: Node = _open_scene_root(str(params.scene_path), what)
    if scene_root == null:
        return
    var parent: Node = _resolve_parent(scene_root, params)
    if parent == null:
        _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
        scene_root.free()
        return

    var layers: Array = params.layers
    var created: Array = []
    for entry: Variant in layers:
        var layer: Dictionary = entry as Dictionary
        var layer_name: String = str(layer.get("name", ""))
        if layer_name == "" or parent.get_node_or_null(layer_name) != null:
            _fail(what + ": layer name '" + layer_name + "' is empty or already used under the parent")
            scene_root.free()
            return
        var texture: Texture2D = load(_res_path(str(layer.get("texture_path", "")))) as Texture2D
        if texture == null:
            _fail(what + ": could not load texture " + str(layer.get("texture_path", "")))
            scene_root.free()
            return
        var node: Node = ClassDB.instantiate("Parallax2D") as Node
        node.name = layer_name
        node.set("scroll_scale", Vector2(float(layer.get("scroll_x", 1.0)), float(layer.get("scroll_y", 1.0))))
        if bool(layer.get("repeat", false)):
            node.set("repeat_size", Vector2(texture.get_width(), 0))
            node.set("repeat_times", int(layer.get("repeat_times", 3)))
        node.set("z_index", int(layer.get("z_index", 0)))
        var sprite: Sprite2D = Sprite2D.new()
        sprite.name = "Sprite2D"
        sprite.texture = texture
        sprite.centered = false
        parent.add_child(node)
        node.owner = scene_root
        node.add_child(sprite)
        sprite.owner = scene_root
        created.append(layer_name)

    if not _save_scene_root(scene_root, str(params.scene_path), what):
        scene_root.free()
        return
    scene_root.free()
    _result({"layers": created})


# ---------------------------------------------------------------------------
# 3D tools: build_blockout, create_pbr_material, bake_navmesh.
# Same conventions as the 2D tools above: "RESULT <json>" on success, "Failed to ..." on stderr.
# ---------------------------------------------------------------------------

# Greybox level from rows of text. Each character of the legend has a height, an optional elevation,
# a color and a collision flag. A run of equal characters in a row becomes one box.
func build_blockout(params: Dictionary) -> void:
    var what: String = "build blockout"
    var scene_root: Node = _open_scene_root(str(params.scene_path), what)
    if scene_root == null:
        return
    var parent: Node = _resolve_parent(scene_root, params)
    if parent == null:
        _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
        scene_root.free()
        return
    var container_name: String = str(params.get("node_name", "Blockout"))
    if parent.get_node_or_null(container_name) != null:
        _fail(what + ": a node named " + container_name + " already exists under the parent")
        scene_root.free()
        return

    var cell_size: float = float(params.get("cell_size", 2.0))
    var styles: Dictionary = {}
    for entry: Variant in params.legend:
        var item: Dictionary = entry as Dictionary
        var material: StandardMaterial3D = StandardMaterial3D.new()
        material.albedo_color = Color.html(str(item.get("color", "#9a9a9a"))) if Color.html_is_valid(str(item.get("color", "#9a9a9a"))) else Color(0.6, 0.6, 0.6)
        styles[str(item.get("char", ""))] = {
            "height": float(item.get("height", 1.0)),
            "elevation": float(item.get("elevation", 0.0)),
            "collision": bool(item.get("collision", true)),
            "material": material,
        }

    var container: Node3D = Node3D.new()
    container.name = container_name
    parent.add_child(container)
    container.owner = scene_root

    var origin_x: int = int(params.get("origin_x", 0))
    var origin_z: int = int(params.get("origin_z", 0))
    var rows: Array = params.rows
    var runs: int = 0
    var cells: int = 0
    for z: int in range(rows.size()):
        var row: String = str(rows[z])
        var x: int = 0
        while x < row.length():
            var character: String = row[x]
            if character == "." or character == " ":
                x += 1
                continue
            if not styles.has(character):
                _fail(what + ": the character '" + character + "' (row " + str(z) + ", column " + str(x) + ") is not in the legend")
                container.free()
                scene_root.free()
                return
            var end: int = x
            while end < row.length() and row[end] == character:
                end += 1
            var count: int = end - x
            var style: Dictionary = styles[character]
            var height: float = style.height
            var size: Vector3 = Vector3(count * cell_size, height, cell_size)
            var box: BoxMesh = BoxMesh.new()
            box.size = size
            box.material = style.material
            var mesh_instance: MeshInstance3D = MeshInstance3D.new()
            mesh_instance.mesh = box
            var holder: Node3D = mesh_instance
            if style.collision:
                holder = StaticBody3D.new()
                mesh_instance.name = "Mesh"
            holder.name = "Run_" + str(z) + "_" + str(x)
            holder.position = Vector3((origin_x + x + count / 2.0) * cell_size, float(style.elevation) + height / 2.0, (origin_z + z + 0.5) * cell_size)
            container.add_child(holder)
            holder.owner = scene_root
            if style.collision:
                holder.add_child(mesh_instance)
                mesh_instance.owner = scene_root
                var shape: CollisionShape3D = CollisionShape3D.new()
                var box_shape: BoxShape3D = BoxShape3D.new()
                box_shape.size = size
                shape.shape = box_shape
                shape.name = "Shape"
                holder.add_child(shape)
                shape.owner = scene_root
            runs += 1
            cells += count
            x = end

    if runs == 0:
        _fail(what + ": the rows have no cells to build")
        container.free()
        scene_root.free()
        return
    if not _save_scene_root(scene_root, str(params.scene_path), what):
        scene_root.free()
        return
    scene_root.free()
    _result({"node": container_name, "boxes": runs, "cells": cells, "cell_size": cell_size})

# Which material slot a texture file belongs to, from the words in its file name. Returns "" when none.
func _pbr_slot(file_name: String) -> String:
    var words: PackedStringArray = file_name.get_basename().to_lower().replace("-", "_").replace(" ", "_").replace(".", "_").split("_", false)
    var table: Array = [
        ["orm", ["orm", "arm"]],
        ["normal", ["normal", "nor", "nrm", "norm"]],
        ["albedo", ["albedo", "basecolor", "base", "color", "diffuse", "diff", "col"]],
        ["roughness", ["roughness", "rough", "rgh"]],
        ["metallic", ["metallic", "metalness", "metal", "mtl"]],
        ["ao", ["ao", "occlusion", "ambientocclusion"]],
        ["emission", ["emission", "emissive", "emit"]],
        ["height", ["height", "displacement", "disp", "bump"]],
    ]
    for pair: Array in table:
        for word: String in pair[1]:
            if word in words:
                return str(pair[0])
    return ""

# StandardMaterial3D from a folder of texture files named like brick_albedo.png, brick_normal.png, brick_roughness.png.
func create_pbr_material(params: Dictionary) -> void:
    var what: String = "create material"
    var folder: String = _res_path(str(params.folder))
    var output_path: String = _res_path(str(params.output_path))
    var dir: DirAccess = DirAccess.open(folder)
    if dir == null:
        _fail(what + ": could not open the folder " + folder)
        return

    var chosen: Dictionary = {}
    var ignored: Array = []
    for file_name: String in dir.get_files():
        var extension: String = file_name.get_extension().to_lower()
        if not (extension in ["png", "jpg", "jpeg", "webp", "tga", "exr", "bmp"]):
            continue
        var slot: String = _pbr_slot(file_name)
        if slot == "":
            ignored.append(file_name)
            continue
        if chosen.has(slot):
            # Two normal maps are usually OpenGL and DirectX; Godot uses OpenGL.
            var lower: String = file_name.to_lower()
            if "gl" in lower.get_basename().replace("-", "_").split("_", false) and not ("gl" in str(chosen[slot]).to_lower().get_basename().replace("-", "_").split("_", false)):
                ignored.append(chosen[slot])
                chosen[slot] = file_name
            else:
                ignored.append(file_name)
            continue
        chosen[slot] = file_name
    if chosen.is_empty():
        _fail(what + ": no texture in " + folder + " has a name with albedo, normal, roughness, metallic, ao, orm, emission or height")
        return

    var textures: Dictionary = {}
    for slot: String in chosen:
        var texture: Texture2D = load(folder.path_join(str(chosen[slot]))) as Texture2D
        if texture == null:
            _fail(what + ": could not load " + str(chosen[slot]) + "; the project may need importing (godot --headless --import)")
            return
        textures[slot] = texture

    var material: StandardMaterial3D = StandardMaterial3D.new()
    if textures.has("albedo"):
        material.albedo_texture = textures.albedo
    if textures.has("normal"):
        material.normal_enabled = true
        material.normal_texture = textures.normal
    if textures.has("orm"):
        # Packed map: occlusion in red, roughness in green, metallic in blue.
        material.ao_enabled = true
        material.ao_texture = textures.orm
        material.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
        material.roughness_texture = textures.orm
        material.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GREEN
        material.metallic_texture = textures.orm
        material.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_BLUE
    else:
        if textures.has("roughness"):
            material.roughness_texture = textures.roughness
        if textures.has("metallic"):
            material.metallic = 1.0
            material.metallic_texture = textures.metallic
        if textures.has("ao"):
            material.ao_enabled = true
            material.ao_texture = textures.ao
    if textures.has("emission"):
        material.emission_enabled = true
        material.emission_texture = textures.emission
    if textures.has("height"):
        material.heightmap_enabled = true
        material.heightmap_texture = textures.height
    var uv_scale: float = float(params.get("uv_scale", 1.0))
    material.uv1_scale = Vector3(uv_scale, uv_scale, uv_scale)
    material.uv1_triplanar = bool(params.get("triplanar", false))

    _make_parent_dir(output_path)
    var save_error: Error = ResourceSaver.save(material, output_path)
    if save_error != OK:
        _fail(what + ": could not save " + output_path + ", error " + str(save_error))
        return

    var assigned: String = ""
    if params.has("scene_path"):
        var scene_root: Node = _open_scene_root(str(params.scene_path), what)
        if scene_root == null:
            return
        var target: GeometryInstance3D = _find_node(scene_root, str(scene_root.name), str(params.get("node_path", ""))) as GeometryInstance3D
        if target == null:
            _fail(what + ": " + str(params.get("node_path", "")) + " is not a MeshInstance3D or other GeometryInstance3D in the scene")
            scene_root.free()
            return
        target.material_override = ResourceLoader.load(output_path, "Material", ResourceLoader.CACHE_MODE_REPLACE) as Material
        if not _save_scene_root(scene_root, str(params.scene_path), what):
            scene_root.free()
            return
        assigned = str(params.node_path)
        scene_root.free()

    var slots: Array = chosen.keys()
    slots.sort()
    _result({"output": output_path, "maps": chosen, "slots": slots, "ignored": ignored, "assigned_to": assigned})

func _strip_scripts(node: Node) -> void:
    node.set_script(null)
    for child: Node in node.get_children():
        _strip_scripts(child)

# Bakes a navigation mesh from the geometry of a scene and adds it in a NavigationRegion3D.
func bake_navmesh(params: Dictionary) -> void:
    var what: String = "bake navmesh"
    var scene_root: Node = _open_scene_root(str(params.scene_path), what)
    if scene_root == null:
        return
    var parent: Node = _resolve_parent(scene_root, params)
    if parent == null:
        _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
        scene_root.free()
        return
    var region_name: String = str(params.get("node_name", "NavigationRegion3D"))
    if parent.get_node_or_null(region_name) != null:
        _fail(what + ": a node named " + region_name + " already exists under the parent")
        scene_root.free()
        return

    var navigation_mesh: NavigationMesh = NavigationMesh.new()
    navigation_mesh.agent_radius = float(params.get("agent_radius", 0.5))
    navigation_mesh.agent_height = float(params.get("agent_height", 1.8))
    navigation_mesh.agent_max_climb = float(params.get("agent_max_climb", 0.25))
    navigation_mesh.agent_max_slope = float(params.get("agent_max_slope", 45.0))
    navigation_mesh.cell_size = float(params.get("cell_size", 0.25))
    navigation_mesh.cell_height = float(params.get("cell_height", 0.25))
    var kinds: Dictionary = {
        "meshes": NavigationMesh.PARSED_GEOMETRY_MESH_INSTANCES,
        "colliders": NavigationMesh.PARSED_GEOMETRY_STATIC_COLLIDERS,
        "both": NavigationMesh.PARSED_GEOMETRY_BOTH,
    }
    navigation_mesh.geometry_parsed_geometry_type = kinds[str(params.get("parsed_geometry", "both"))]

    # The geometry is read from the nodes' global transforms, so a scene has to be in the tree. That is a
    # second copy of the scene, with its scripts removed so their _ready does not run; the copy that is
    # saved never enters the tree.
    var geometry_scene: Node = (load(_res_path(str(params.scene_path))) as PackedScene).instantiate()
    if not bool(params.get("run_scripts", false)):
        _strip_scripts(geometry_scene)
    root.add_child(geometry_scene)
    var geometry_root: Node = geometry_scene
    if params.has("geometry_path"):
        geometry_root = _find_node(geometry_scene, str(geometry_scene.name), str(params.geometry_path))
    if geometry_root == null:
        _fail(what + ": geometry node not found: " + str(params.geometry_path))
        geometry_scene.free()
        scene_root.free()
        return

    var source: NavigationMeshSourceGeometryData3D = NavigationMeshSourceGeometryData3D.new()
    NavigationServer3D.parse_source_geometry_data(navigation_mesh, source, geometry_root)
    var has_geometry: bool = source.has_data()
    if has_geometry:
        NavigationServer3D.bake_from_source_geometry_data(navigation_mesh, source)
    root.remove_child(geometry_scene)
    geometry_scene.free()
    if not has_geometry:
        _fail(what + ": found no geometry to bake; the scene needs MeshInstance3D nodes or static colliders (see parsedGeometry)")
        scene_root.free()
        return
    var polygons: int = navigation_mesh.get_polygon_count()
    if polygons == 0:
        _fail(what + ": the bake made no walkable area; check the floor, the agent size and the cell size")
        scene_root.free()
        return

    var region: NavigationRegion3D = NavigationRegion3D.new()
    region.name = region_name
    region.navigation_mesh = navigation_mesh
    parent.add_child(region)
    region.owner = scene_root
    if not _save_scene_root(scene_root, str(params.scene_path), what):
        scene_root.free()
        return
    scene_root.free()
    _result({"node": region_name, "polygons": polygons, "vertices": navigation_mesh.get_vertices().size()})

# Saves the mesh of the first MeshInstance3D of a scene (a .glb, for example) as a Mesh resource, so that a
# MultiMesh can point to it. mesh_node picks a MeshInstance3D by name.
func extract_mesh(params: Dictionary) -> void:
    var what: String = "extract mesh"
    var source_path: String = _res_path(str(params.source_path))
    var output_path: String = _res_path(str(params.output_path))
    var loaded: Resource = load(source_path)
    if not (loaded is PackedScene):
        _fail(what + ": " + source_path + " is not a scene or a model that Godot imports as a scene")
        return
    var instance: Node = (loaded as PackedScene).instantiate()
    var candidates: Array = instance.find_children("*", "MeshInstance3D", true, false)
    if instance is MeshInstance3D:
        candidates.push_front(instance)
    if params.has("mesh_node"):
        candidates = candidates.filter(func(candidate: Node) -> bool: return str(candidate.name) == str(params.mesh_node))
    if candidates.is_empty():
        _fail(what + ": " + source_path + " has no MeshInstance3D" + (" named " + str(params.mesh_node) if params.has("mesh_node") else ""))
        instance.free()
        return
    var mesh: Mesh = (candidates[0] as MeshInstance3D).mesh
    if mesh == null or mesh.get_surface_count() == 0:
        _fail(what + ": the MeshInstance3D has no mesh data")
        instance.free()
        return
    var vertices: int = 0
    for surface: int in range(mesh.get_surface_count()):
        var arrays: Array = mesh.surface_get_arrays(surface)
        if not arrays.is_empty() and arrays[Mesh.ARRAY_VERTEX] != null:
            vertices += (arrays[Mesh.ARRAY_VERTEX] as PackedVector3Array).size()
    if vertices == 0:
        _fail(what + ": Godot could not read the vertices of the mesh")
        instance.free()
        return
    _make_parent_dir(output_path)
    var save_error: Error = ResourceSaver.save(mesh, output_path)
    var surfaces: int = mesh.get_surface_count()
    instance.free()
    if save_error != OK:
        _fail(what + ": could not save " + output_path + ", error " + str(save_error))
        return
    _result({"output": output_path, "surfaces": surfaces, "vertices": vertices})


# ---------------------------------------------------------------------------
# UI tools: build_ui, make_theme.
# ---------------------------------------------------------------------------

const ANCHOR_PRESETS: Dictionary = {
    "top_left": Control.PRESET_TOP_LEFT,
    "top_right": Control.PRESET_TOP_RIGHT,
    "bottom_left": Control.PRESET_BOTTOM_LEFT,
    "bottom_right": Control.PRESET_BOTTOM_RIGHT,
    "center_left": Control.PRESET_CENTER_LEFT,
    "center_top": Control.PRESET_CENTER_TOP,
    "center_right": Control.PRESET_CENTER_RIGHT,
    "center_bottom": Control.PRESET_CENTER_BOTTOM,
    "center": Control.PRESET_CENTER,
    "left_wide": Control.PRESET_LEFT_WIDE,
    "top_wide": Control.PRESET_TOP_WIDE,
    "right_wide": Control.PRESET_RIGHT_WIDE,
    "bottom_wide": Control.PRESET_BOTTOM_WIDE,
    "vcenter_wide": Control.PRESET_VCENTER_WIDE,
    "hcenter_wide": Control.PRESET_HCENTER_WIDE,
    "full_rect": Control.PRESET_FULL_RECT,
}

const SIZE_FLAG_NAMES: Dictionary = {
    "fill": Control.SIZE_FILL,
    "expand": Control.SIZE_EXPAND,
    "expand_fill": Control.SIZE_EXPAND_FILL,
    "shrink_begin": Control.SIZE_SHRINK_BEGIN,
    "shrink_center": Control.SIZE_SHRINK_CENTER,
    "shrink_end": Control.SIZE_SHRINK_END,
}

# Offsets of one axis for a preset: a point anchor places the control by its size, a wide one stretches it.
func _preset_offsets(anchor_begin: float, anchor_end: float, length: float) -> Array:
    if not is_equal_approx(anchor_begin, anchor_end):
        return [0.0, 0.0]
    return [-length * anchor_begin, length * (1.0 - anchor_begin)]

func _grow_for(anchor_begin: float, anchor_end: float) -> int:
    if not is_equal_approx(anchor_begin, anchor_end):
        return Control.GROW_DIRECTION_END
    if is_equal_approx(anchor_begin, 0.5):
        return Control.GROW_DIRECTION_BOTH
    return Control.GROW_DIRECTION_BEGIN if anchor_begin > 0.5 else Control.GROW_DIRECTION_END

# set_anchors_and_offsets_preset needs the parent's size, which a scene that is not open does not have,
# so the offsets are worked out here from the control's minimum size.
func _apply_anchor_preset(control: Control, preset_name: String) -> bool:
    if not ANCHOR_PRESETS.has(preset_name):
        return false
    control.set_anchors_preset(ANCHOR_PRESETS[preset_name] as int)
    var minimum: Vector2 = control.custom_minimum_size.max(control.get_minimum_size())
    var horizontal: Array = _preset_offsets(control.anchor_left, control.anchor_right, minimum.x)
    var vertical: Array = _preset_offsets(control.anchor_top, control.anchor_bottom, minimum.y)
    control.offset_left = horizontal[0]
    control.offset_right = horizontal[1]
    control.offset_top = vertical[0]
    control.offset_bottom = vertical[1]
    control.grow_horizontal = _grow_for(control.anchor_left, control.anchor_right) as Control.GrowDirection
    control.grow_vertical = _grow_for(control.anchor_top, control.anchor_bottom) as Control.GrowDirection
    return true

func _ui_property_info(node: Object, property_name: String) -> Dictionary:
    for info: Dictionary in node.get_property_list():
        if str(info.name) == property_name:
            return info
    return {}

# Turns a JSON value into the value a property takes: enum names, #hex colors, [x, y] vectors, res:// paths and
# Godot literals. Returns {ok, value, error}.
func _ui_value(info: Dictionary, value: Variant) -> Dictionary:
    var type: int = int(info.type)
    if typeof(value) == TYPE_STRING:
        var text: String = value
        if type == TYPE_INT and int(info.hint) == PROPERTY_HINT_ENUM:
            var options: PackedStringArray = str(info.hint_string).split(",")
            for index: int in range(options.size()):
                var parts: PackedStringArray = options[index].split(":")
                if parts[0].strip_edges().to_lower().replace(" ", "_") == text.to_lower().replace(" ", "_"):
                    return {"ok": true, "value": int(parts[1]) if parts.size() > 1 else index, "error": ""}
            return {"ok": false, "value": null, "error": "'" + text + "' is not one of: " + str(info.hint_string)}
        if type == TYPE_COLOR and Color.html_is_valid(text):
            return {"ok": true, "value": Color.html(text), "error": ""}
        if type == TYPE_STRING_NAME:
            return {"ok": true, "value": StringName(text), "error": ""}
        if type == TYPE_NODE_PATH:
            return {"ok": true, "value": NodePath(text), "error": ""}
    if typeof(value) == TYPE_ARRAY:
        var items: Array = value
        if type == TYPE_VECTOR2 and items.size() == 2:
            return {"ok": true, "value": Vector2(float(items[0]), float(items[1])), "error": ""}
        if type == TYPE_VECTOR2I and items.size() == 2:
            return {"ok": true, "value": Vector2i(int(items[0]), int(items[1])), "error": ""}
        if type == TYPE_COLOR and (items.size() == 3 or items.size() == 4):
            return {"ok": true, "value": Color(float(items[0]), float(items[1]), float(items[2]), float(items[3]) if items.size() == 4 else 1.0), "error": ""}
        if type == TYPE_RECT2 and items.size() == 4:
            return {"ok": true, "value": Rect2(float(items[0]), float(items[1]), float(items[2]), float(items[3])), "error": ""}
    if typeof(value) == TYPE_FLOAT and type == TYPE_INT:
        return {"ok": true, "value": int(value), "error": ""}
    return convert_property_value(type, value)

# Applies the props of one node of a UI spec. Returns an error message, or "" when all went well.
func _apply_ui_props(node: Control, props: Dictionary, warnings: Array) -> String:
    for key: String in props:
        var value: Variant = props[key]
        match key:
            "script":
                return "script cannot be set from a UI spec"
            "anchors":
                if not _apply_anchor_preset(node, str(value)):
                    return "anchors must be one of: " + ", ".join(ANCHOR_PRESETS.keys())
                if node.get_parent() is Container:
                    warnings.append(str(node.name) + ": anchors are ignored inside a container; its parent places it")
            "margins":
                if not (node is MarginContainer):
                    return "margins only applies to a MarginContainer"
                var sides: Dictionary = {}
                if typeof(value) == TYPE_DICTIONARY:
                    sides = value
                else:
                    sides = {"left": value, "top": value, "right": value, "bottom": value}
                for side: String in sides:
                    if not (side in ["left", "top", "right", "bottom"]):
                        return "margins accepts left, top, right and bottom"
                    node.add_theme_constant_override("margin_" + side, int(sides[side]))
            "separation":
                node.add_theme_constant_override("separation", int(value))
            "size_flags_horizontal", "size_flags_vertical":
                var flags: int = 0
                if typeof(value) == TYPE_STRING:
                    if not SIZE_FLAG_NAMES.has(str(value)):
                        return key + " must be one of: " + ", ".join(SIZE_FLAG_NAMES.keys())
                    flags = SIZE_FLAG_NAMES[str(value)]
                else:
                    flags = int(value)
                node.set(key, flags)
            "theme_constants":
                for constant_name: String in (value as Dictionary):
                    node.add_theme_constant_override(constant_name, int((value as Dictionary)[constant_name]))
            "theme_font_sizes":
                for size_name: String in (value as Dictionary):
                    node.add_theme_font_size_override(size_name, int((value as Dictionary)[size_name]))
            "theme_colors":
                for color_name: String in (value as Dictionary):
                    var color_text: String = str((value as Dictionary)[color_name])
                    if not Color.html_is_valid(color_text):
                        return "theme_colors." + color_name + " must be a color like #ffffff"
                    node.add_theme_color_override(color_name, Color.html(color_text))
            _:
                var info: Dictionary = _ui_property_info(node, key)
                if info.is_empty():
                    return str(node.get_class()) + " has no property " + key
                var converted: Dictionary = _ui_value(info, value)
                if not converted.ok:
                    return key + ": " + str(converted.error)
                node.set(key, converted.value)
                if not values_match(node.get(key), converted.value):
                    return key + " did not take the value " + var_to_str(converted.value)
    return ""

func _set_owner_recursive(node: Node, owner_node: Node) -> void:
    node.owner = owner_node
    for child: Node in node.get_children():
        _set_owner_recursive(child, owner_node)

# Builds one node of a UI spec ({type, name, props, children}) and, recursively, its children. Returns null
# after reporting the failure.
func _build_ui_node(spec: Dictionary, parent: Node, warnings: Array, counter: Array) -> Control:
    var type_name: String = str(spec.get("type", ""))
    if not ClassDB.class_exists(type_name) or not ClassDB.can_instantiate(type_name) or not ClassDB.is_parent_class(type_name, "Control"):
        _fail("build ui: " + type_name + " is not a Control class that can be created")
        return null
    var node_name: String = str(spec.get("name", type_name))
    if parent != null and parent.get_node_or_null(node_name) != null:
        _fail("build ui: " + str(parent.name) + " already has a child named " + node_name)
        return null
    var node: Control = ClassDB.instantiate(type_name) as Control
    node.name = node_name
    if parent != null:
        parent.add_child(node)
    var props: Dictionary = spec.get("props", {}) as Dictionary
    var problem: String = _apply_ui_props(node, props, warnings)
    if problem != "":
        _fail("build ui: " + node_name + " (" + type_name + "): " + problem)
        return null
    counter[0] = int(counter[0]) + 1
    for child_spec: Variant in spec.get("children", []):
        if _build_ui_node(child_spec as Dictionary, node, warnings, counter) == null:
            return null
    return node

# Builds a tree of Control nodes from a JSON spec. When the scene exists the tree is added under a parent node;
# when it does not, the spec's root becomes the root of a new scene.
func build_ui(params: Dictionary) -> void:
    var what: String = "build ui"
    var spec: Dictionary = params.tree
    var scene_path: String = str(params.scene_path)
    var creating: bool = not FileAccess.file_exists(_res_path(scene_path))
    var warnings: Array = []
    var counter: Array = [0]
    var scene_root: Node = null
    var built: Control = null
    if creating:
        built = _build_ui_node(spec, null, warnings, counter)
        if built == null:
            return
        scene_root = built
        for child: Node in built.get_children():
            _set_owner_recursive(child, built)
        _make_parent_dir(_res_path(scene_path))
    else:
        scene_root = _open_scene_root(scene_path, what)
        if scene_root == null:
            return
        var parent: Node = _resolve_parent(scene_root, params)
        if parent == null:
            _fail(what + ": parent node not found: " + str(params.get("parent_node_path", "")))
            scene_root.free()
            return
        built = _build_ui_node(spec, parent, warnings, counter)
        if built == null:
            scene_root.free()
            return
        _set_owner_recursive(built, scene_root)
    if not _save_scene_root(scene_root, scene_path, what):
        scene_root.free()
        return
    var root_name: String = str(scene_root.name)
    var built_path: String = root_name if built == scene_root else root_name + "/" + str(scene_root.get_path_to(built))
    scene_root.free()
    _result({"root": built_path, "nodes": int(counter[0]), "created_scene": creating, "warnings": warnings})

# --- themes

func _ui_color(value: Variant, fallback: Color) -> Color:
    if typeof(value) == TYPE_STRING and Color.html_is_valid(str(value)):
        return Color.html(str(value))
    return fallback

func _luminance(color: Color) -> float:
    var linear: Array = []
    for channel: float in [color.r, color.g, color.b]:
        linear.append(channel / 12.92 if channel <= 0.03928 else pow((channel + 0.055) / 1.055, 2.4))
    return 0.2126 * float(linear[0]) + 0.7152 * float(linear[1]) + 0.0722 * float(linear[2])

func _contrast_ratio(first: Color, second: Color) -> float:
    var a: float = _luminance(first)
    var b: float = _luminance(second)
    return (maxf(a, b) + 0.05) / (minf(a, b) + 0.05)

func _best_text_on(background: Color) -> Color:
    return Color.WHITE if _contrast_ratio(Color.WHITE, background) >= _contrast_ratio(Color.BLACK, background) else Color.BLACK

func _flat_box(fill: Color, border: Color, radius: int, border_width: int, padding: int) -> StyleBoxFlat:
    var box: StyleBoxFlat = StyleBoxFlat.new()
    box.bg_color = fill
    box.border_color = border
    box.set_border_width_all(border_width)
    box.set_corner_radius_all(radius)
    box.set_content_margin_all(float(padding))
    return box

func _style_button_type(theme: Theme, type_name: String, normal: Color, hover: Color, pressed: Color, border: Color, focus: Color, radius: int, border_width: int, padding: int) -> void:
    theme.set_stylebox("normal", type_name, _flat_box(normal, border, radius, border_width, padding))
    theme.set_stylebox("hover", type_name, _flat_box(hover, border, radius, border_width, padding))
    theme.set_stylebox("pressed", type_name, _flat_box(pressed, border, radius, border_width, padding))
    theme.set_stylebox("disabled", type_name, _flat_box(Color(normal.r, normal.g, normal.b, 0.5), border, radius, border_width, padding))
    var ring: StyleBoxFlat = _flat_box(Color(0, 0, 0, 0), focus, radius, 2, padding)
    ring.draw_center = false
    theme.set_stylebox("focus", type_name, ring)
    var text_normal: Color = _best_text_on(normal)
    theme.set_color("font_color", type_name, text_normal)
    theme.set_color("font_hover_color", type_name, _best_text_on(hover))
    theme.set_color("font_pressed_color", type_name, _best_text_on(pressed))
    theme.set_color("font_focus_color", type_name, text_normal)
    theme.set_color("font_disabled_color", type_name, Color(text_normal.r, text_normal.g, text_normal.b, 0.5))

# A Theme (.tres) from a palette: button states and variations, panels, labels, text fields and progress bars.
func make_theme(params: Dictionary) -> void:
    var what: String = "make theme"
    var output_path: String = _res_path(str(params.output_path))
    var palette: Dictionary = params.get("palette", {}) as Dictionary
    var background: Color = _ui_color(palette.get("background"), Color("#1e1f26"))
    var text: Color = _ui_color(palette.get("text"), Color("#e8e8ea"))
    var primary: Color = _ui_color(palette.get("primary"), Color("#4f8cff"))
    var accent: Color = _ui_color(palette.get("accent"), Color("#ffb454"))
    var danger: Color = _ui_color(palette.get("danger"), Color("#e5484d"))
    var radius: int = int(params.get("radius", 6))
    var border_width: int = int(params.get("border_width", 1))
    var padding: int = int(params.get("padding", 10))
    var surface: Color = background.lerp(text, 0.08)
    var surface_hover: Color = background.lerp(text, 0.16)
    var surface_pressed: Color = background.lerp(text, 0.04)
    var border: Color = background.lerp(text, 0.28)

    var theme: Theme = Theme.new()
    theme.default_font_size = int(params.get("font_size", 16))
    if params.has("font_path"):
        var font: Font = load(_res_path(str(params.font_path))) as Font
        if font == null:
            _fail(what + ": could not load the font " + str(params.font_path))
            return
        theme.default_font = font

    var styled: Array = ["Button", "OptionButton", "PrimaryButton", "AccentButton", "DangerButton", "Panel", "PanelContainer", "Label", "LineEdit", "ProgressBar", "CheckBox", "CheckButton"]
    for type_name: String in ["Button", "OptionButton"]:
        _style_button_type(theme, type_name, surface, surface_hover, surface_pressed, border, primary, radius, border_width, padding)
    for variation: Array in [["PrimaryButton", primary], ["AccentButton", accent], ["DangerButton", danger]]:
        var variation_name: String = variation[0]
        var base: Color = variation[1]
        theme.set_type_variation(variation_name, "Button")
        _style_button_type(theme, variation_name, base, base.lightened(0.12), base.darkened(0.15), base, text, radius, 0, padding)

    theme.set_stylebox("panel", "Panel", _flat_box(background, border, radius, border_width, padding))
    theme.set_stylebox("panel", "PanelContainer", _flat_box(surface, border, radius, border_width, padding))
    theme.set_color("font_color", "Label", text)
    for type_name: String in ["CheckBox", "CheckButton"]:
        theme.set_color("font_color", type_name, text)
        theme.set_color("font_hover_color", type_name, text)
        theme.set_color("font_pressed_color", type_name, text)
        theme.set_color("font_focus_color", type_name, text)
        theme.set_color("font_disabled_color", type_name, Color(text.r, text.g, text.b, 0.5))

    var field: Color = background.darkened(0.15)
    theme.set_stylebox("normal", "LineEdit", _flat_box(field, border, radius, border_width, padding))
    theme.set_stylebox("read_only", "LineEdit", _flat_box(surface, border, radius, border_width, padding))
    theme.set_stylebox("focus", "LineEdit", _flat_box(field, primary, radius, 2, padding))
    theme.set_color("font_color", "LineEdit", text)
    theme.set_color("font_placeholder_color", "LineEdit", Color(text.r, text.g, text.b, 0.6))
    theme.set_color("caret_color", "LineEdit", primary)
    theme.set_color("selection_color", "LineEdit", Color(primary.r, primary.g, primary.b, 0.45))
    theme.set_stylebox("background", "ProgressBar", _flat_box(surface, border, radius, border_width, 4))
    theme.set_stylebox("fill", "ProgressBar", _flat_box(primary, primary, radius, 0, 4))
    theme.set_color("font_color", "ProgressBar", _best_text_on(primary))

    _make_parent_dir(output_path)
    var save_error: Error = ResourceSaver.save(theme, output_path)
    if save_error != OK:
        _fail(what + ": could not save " + output_path + ", error " + str(save_error))
        return

    var assigned: String = ""
    if params.has("scene_path"):
        var scene_root: Node = _open_scene_root(str(params.scene_path), what)
        if scene_root == null:
            return
        var target: Control = _find_node(scene_root, str(scene_root.name), str(params.get("node_path", ""))) as Control
        if target == null:
            _fail(what + ": " + str(params.get("node_path", "")) + " is not a Control in the scene")
            scene_root.free()
            return
        target.theme = ResourceLoader.load(output_path, "Theme", ResourceLoader.CACHE_MODE_REPLACE) as Theme
        if not _save_scene_root(scene_root, str(params.scene_path), what):
            scene_root.free()
            return
        assigned = str(params.node_path)
        scene_root.free()
    _result({"output": output_path, "types": styled, "assigned_to": assigned})
