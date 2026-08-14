FROM python:3.11-slim
WORKDIR /app
# deepfilternet's init_df() shells out to `git rev-parse` internally just to log which
# commit it's running from -- crashes with FileNotFoundError without git present at all
# (confirmed empirically against this exact base image; libgomp1, commonly needed by
# other torch wheel builds, is NOT needed by the CPU-only wheel pinned in
# requirements.txt -- also confirmed empirically, not assumed).
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
# Bakes real model weights into this image layer at build time instead of a lazy
# runtime download -- avoids re-downloading on every deploy (this container is fully
# replaced on every push to develop/main) and avoids a slow cold start. Calls the exact
# same load() the app uses at runtime (main.py's lifespan), so a broken load() fails
# the image build loudly instead of silently degrading to pass-through in production.
# Relies on the bake step and the final CMD sharing the same $HOME (true by default,
# no USER directive changes it) so torch.hub's and DeepFilterNet's default
# $HOME-relative caches land somewhere the runtime process finds them too.
RUN python -c "from app.vad import SileroVAD; from app.denoise import Denoiser; SileroVAD().load(); Denoiser().load()"
EXPOSE 8090
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
