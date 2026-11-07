import os
from pathlib import Path
import shutil
import sys
import tempfile


def export_scene(source, destination):
    import bpy

    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    if bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False) != {"FINISHED"}:
        raise RuntimeError("Blender could not open the uploaded file")

    # A preview has access to packed textures from the uploaded file.
    for image in list(bpy.data.images):
        if image.source in {"FILE", "TILED", "SEQUENCE", "MOVIE"} and not image.packed_files:
            bpy.data.images.remove(image)

    result = bpy.ops.export_scene.gltf(
        filepath=str(destination),
        export_format="GLB",
        use_active_scene=True,
        export_animations=False,
        export_lights=True,
    )
    if result != {"FINISHED"}:
        raise RuntimeError("Blender could not export the preview")


if __name__ == "__main__":
    # Blender logs to stdout. Reserve the original stream for binary GLB data.
    with os.fdopen(os.dup(sys.stdout.fileno()), "wb") as result:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "scene.blend"
            destination = Path(directory) / "preview.glb"
            with source.open("wb") as uploaded:
                shutil.copyfileobj(sys.stdin.buffer, uploaded)
            export_scene(source, destination)
            with destination.open("rb") as exported:
                shutil.copyfileobj(exported, result)
