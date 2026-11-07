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
if [[ ! -x "$runtime/env/bin/python" ]]; then
    "$uv" venv --managed-python --python 3.13 "$runtime/env"
fi
"$uv" pip install --python "$runtime/env/bin/python" --only-binary=:all: bpy==5.2.3
