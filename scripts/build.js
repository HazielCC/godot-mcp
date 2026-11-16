import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Make the build/index.js file executable
fs.chmodSync(path.join(__dirname, '..', 'build', 'index.js'), '755');

// Copy the scripts directory to the build directory
try {
  // Ensure the build/scripts directory exists
  fs.ensureDirSync(path.join(__dirname, '..', 'build', 'scripts'));
  
  // Copy the godot_operations.gd file
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    path.join(__dirname, '..', 'build', 'scripts', 'godot_operations.gd')
  );
  
  // Copy the check_scripts.gd file used by check_script and check_project_scripts
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'check_scripts.gd'),
    path.join(__dirname, '..', 'build', 'scripts', 'check_scripts.gd')
  );

  // Copy render_scene.gd used by render_scene_2d
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'render_scene.gd'),
    path.join(__dirname, '..', 'build', 'scripts', 'render_scene.gd')
  );

  // Copy render_scene_3d.gd used by render_scene_3d
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'render_scene_3d.gd'),
    path.join(__dirname, '..', 'build', 'scripts', 'render_scene_3d.gd')
  );

  // Copy render_scene_ui.gd, inspect_ui.gd and render_particles.gd used by the UI and particle tools
  for (const script of ['render_scene_ui.gd', 'inspect_ui.gd', 'render_particles.gd']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'src', 'scripts', script),
      path.join(__dirname, '..', 'build', 'scripts', script)
    );
  }

  // Copy the editor bridge plugin (addons/godot_mcp_bridge), installed into projects on request
  fs.copySync(
    path.join(__dirname, '..', 'src', 'addons', 'godot_mcp_bridge'),
    path.join(__dirname, '..', 'build', 'addons', 'godot_mcp_bridge')
  );

  console.log('Successfully copied godot_operations.gd, check_scripts.gd and the editor bridge to build');
} catch (error) {
  console.error('Error copying scripts:', error);
  process.exit(1);
}

console.log('Build scripts completed successfully!');
