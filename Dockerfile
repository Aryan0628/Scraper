# Node runs the TypeScript directly (native type-stripping), so there is no
# build step and no compiled output -- the source IS the artifact.
FROM node:24-slim

WORKDIR /app

# Deps first for layer caching. Only package files invalidate this layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Source. data/ is intentionally NOT copied: the crawler refreshes the sitemap
# itself, snapshots are a rebuildable cache, and the real state lives in Postgres
# (body_fetched_at), so an ephemeral container filesystem loses nothing.
COPY src ./src
COPY scripts ./scripts

# The session and DB URL are injected by the platform (GCP env / Secret Manager),
# never baked into the image:
#   DATABASE_URL   Neon connection string
#   OA_SESSION     storageState JSON (or base64) from scripts/login.ts
# No --env-file here on purpose; GCP provides env directly. Locally, run with
#   docker run --env-file .env ...
CMD ["node", "scripts/crawl.ts", "backfill"]
