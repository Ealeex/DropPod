# Blender preview handoff

This records the original pause on `feature/blend-preview`. The first implementation is in commit `d472029`. Work resumed with the merge in `b2abe95`.

## What the feature does

The shared drive can preview a `.blend` file in its 3D drawer. An authenticated request converts the active Blender scene to GLB and caches the result. Pack textures into the Blender file before upload. External linked assets, procedural material fidelity, and animation are outside the initial scope.

The existing Three.js viewer opens in Orbit mode. Fly mode adds WASD movement, R/F for vertical movement, mouse look with pointer lock or drag, and a speed slider. The same controls are available in the existing OBJ, FBX, and DAE previews.

`blend-preview.js` manages conversion and caching. It allows one active conversion with a bounded queue, combines concurrent requests for the same file, and limits the input and output to 128 MiB each with a 60-second server timeout. Deleting a file removes its cached preview. `tools/blender-preview/convert.py` reads the upload on standard input, disables automatic Blender scripts, and writes the GLB to standard output. The shared viewer and fly controls now live in `public/previews/model.mjs` and `public/previews/fly-controls.mjs`. `model-blend.mjs` routes the converted scene through the GLB renderer.

## What we verified

- Blender 5.2.3 on Windows and the Linux x86-64 `bpy` 5.2.3 wheel under Ubuntu WSL both exported a synthetic scene with a packed texture. The texture was embedded in the GLB. The active-scene exporter option in this version is `use_active_scene=True`. The Linux wheel produced a usable GLB without the optional Draco and MeshOptimizer libraries.
- Edge displayed the textured scene through the app using a simulated Docker command. The test covered Orbit and Fly, movement and speed controls, an existing OBJ preview, authentication, the download stream, cache reuse and cleanup, and the error for an invalid Blender file.
- Docker was unavailable on the development machine. The Docker image build and conversion inside the actual container remain unverified.

## Follow-up verification

On Windows, the project had moved since setup and the WSL environment's Python link still pointed to the original checkout. The setup script now recreates that environment when its interpreter points outside the current runtime. The runner also detects a stale link before starting Bubblewrap.

The real Ubuntu WSL runner exported the packed-texture fixture. A separate isolation check confirmed that Bubblewrap uses its own network namespace and the worker cannot see the host project files. Edge verified the authenticated preview, the embedded texture, concurrent requests and cache cleanup, an invalid upload, and keyboard and drag movement in Fly mode. The same viewer still opens a regular GLB file. The live server configuration was left as it was.

The Docker route still needs a build and conversion test on a Docker host. See the README for both setup paths.
