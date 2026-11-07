#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
runtime="$(realpath -m "$here/../blender-runtime")"
uv="${UV_BIN:-uv}"
if [[ "$(uname -m)" != x86_64 ]] || ! command -v bwrap >/dev/null || ! command -v "$uv" >/dev/null; then
    echo "Use x86-64 Ubuntu on WSL with Bubblewrap and uv installed." >&2
    exit 1
fi

mkdir -p "$runtime"
export UV_PYTHON_INSTALL_DIR="$runtime/python"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$runtime/cache}"
"$uv" python install 3.13 --no-bin
python="$(realpath -e "$runtime/env/bin/python" 2>/dev/null || true)"
if [[ "$python" != "$runtime/python/"* || ! -x "$python" ]]; then
    # A moved checkout can leave an absolute Python link pointing to the old location.
  if [[ -L "$runtime/env" || ( -e "$runtime/env" && ! -f "$runtime/env/pyvenv.cfg" ) ]]; then
    echo "Expected a managed Blender environment at $runtime/env." >&2
    exit 1
  fi
  "$uv" venv --clear --managed-python --python 3.13 "$runtime/env"
fi
"$uv" pip install --python "$runtime/env/bin/python" --only-binary=:all: bpy==5.2.3
