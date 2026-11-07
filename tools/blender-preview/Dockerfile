FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libgomp1 libsm6 libx11-6 libxext6 libxfixes3 libxi6 libxrender1 libxxf86vm1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --only-binary=:all: bpy==5.2.3 \
    && python -c "import bpy; bpy.ops.export_scene.gltf.get_rna_type()"

ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
COPY convert.py /opt/firesend/convert.py
USER 65534:65534
ENTRYPOINT ["python", "/opt/firesend/convert.py"]
