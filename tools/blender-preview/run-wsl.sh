#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
runtime="$(realpath -m "$here/../blender-runtime")"
if ! command -v bwrap >/dev/null || ! command -v timeout >/dev/null || ! command -v prlimit >/dev/null ||
    [[ ! -x "$runtime/env/bin/python" ]]; then
    echo "Run tools/blender-preview/setup-wsl.sh in the configured WSL distribution first." >&2
    exit 125
fi

exec timeout --kill-after=3s 55s prlimit --as=4294967296 -- \
    bwrap --unshare-all --unshare-user --disable-userns --die-with-parent --new-session --clearenv \
    --ro-bind /usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu \
    --ro-bind /usr/lib64 /usr/lib64 --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
    --ro-bind "$runtime/python" "$runtime/python" \
    --ro-bind "$runtime/env" "$runtime/env" \
    --ro-bind "$here/convert.py" /convert.py \
    --proc /proc --dev /dev --size 402653184 --tmpfs /tmp --chdir /tmp \
    --setenv HOME /tmp --setenv PYTHONDONTWRITEBYTECODE 1 \
    --setenv OMP_NUM_THREADS 2 --setenv OPENBLAS_NUM_THREADS 2 \
    -- "$runtime/env/bin/python" /convert.py
