# Blender preview handoff

Work on this feature is paused on `feature/blend-preview`. The implementation is in commit `d472029`.

## What the feature does

The shared drive can preview a `.blend` file in its 3D drawer. An authenticated request converts the active Blender scene to GLB and caches the result. Pack textures into the Blender file before upload. External linked assets, procedural material fidelity, and animation are outside the initial scope.

The existing Three.js viewer opens in Orbit mode. Fly mode adds WASD movement, R/F for vertical movement, mouse look with pointer lock or drag, and a speed slider. The same controls are available in the existing OBJ, FBX, and DAE previews.

`blend-preview.js` manages conversion and caching. It allows one active conversion with a bounded queue, combines concurrent requests for the same file, and limits the input and output to 128 MiB each with a 60-second server timeout. Deleting a file removes its cached preview. `tools/blender-preview/convert.py` reads the upload on standard input, disables automatic Blender scripts, and writes the GLB to standard output. The viewer and fly controls live in `public/model-viewer.mjs` and `public/fly-controls.mjs`.

## What we verified

- Blender 5.2.3 on Windows and the Linux x86-64 `bpy` 5.2.3 wheel under Ubuntu WSL both exported a synthetic scene with a packed texture. The texture was embedded in the GLB. The active-scene exporter option in this version is `use_active_scene=True`. The Linux wheel produced a usable GLB without the optional Draco and MeshOptimizer libraries.
- Edge displayed the textured scene through the app using a simulated Docker command. The test covered Orbit and Fly, movement and speed controls, an existing OBJ preview, authentication, the download stream, cache reuse and cleanup, and the error for an invalid Blender file.
- Docker was unavailable on the development machine. The Docker image build and conversion inside the actual container remain unverified.

## Where to resume

The draft Windows setup uses Ubuntu on WSL. `tools/blender-preview/setup-wsl.sh` installs a project-local Python and Blender runtime. `run-wsl.sh` uses Bubblewrap to give the worker read-only access to its runtime and system libraries, a private temporary filesystem, and an isolated network namespace. WSL path translation and a basic Bubblewrap isolation check passed separately. The final runner and its isolation settings still need an end-to-end test with the real worker.

First verify the setup and run the packed-texture fixture through `run-wsl.sh`. Then use a test server with `BLENDER_PREVIEW_WSL_DISTRO=Ubuntu` to check the authenticated preview and fly controls with the real runner. The live server was left with its existing configuration. On a Docker host, build and verify the separate `BLENDER_PREVIEW_IMAGE` route. The README has setup commands for both paths.
