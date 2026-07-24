# CanvasXpress Dashboards — self-hostable server + no-code app.
#
#   docker build -t cxd-server .
#   docker run -p 8000:8000 -v cxd-data:/data cxd-server
#
# Then open http://localhost:8000/ and sign in (create an account, or use the
# demo button). All persistent state lives under /data (mount a volume to keep
# it): the SQLite DB, uploaded datasets, and the generated session secret.
#
# To enable Postgres / S3 / Google Drive / SQL stores, add their extras at build
# time:  docker build --build-arg CXD_EXTRAS="web,sql,s3" -t cxd-server .
# then point the CXD_* env vars (see .env.example) at your resources.

FROM python:3.12-slim AS base

# Optional dependency extras to install (see server/pyproject.toml).
ARG CXD_EXTRAS=web

WORKDIR /app

# Install the server package. The wheel bundles the static app shell + bundle
# under cxd_server/static, so the served app at `/` needs no extra copy step.
COPY server/ /app/server/
RUN pip install --no-cache-dir "./server[${CXD_EXTRAS}]"

# Persistent runtime state (DB, datasets, session secret) lives here — mount a
# volume so it survives container restarts/rebuilds.
ENV APP_DB_PATH=/data/dashboards.db \
    CXD_DATASET_STORE=file:///data/cxd-datasets \
    CXD_SECRET_FILE=/data/.session_secret \
    CXD_HOST=0.0.0.0 \
    CXD_PORT=8000
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

# The launcher generates + persists SESSION_SECRET on first run, so no key
# management is needed for a single instance. For multi-instance deploys, set
# SESSION_SECRET explicitly so every replica shares one key.
CMD ["python", "-m", "cxd_server"]
