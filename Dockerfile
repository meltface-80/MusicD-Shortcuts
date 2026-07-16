# syntax=docker/dockerfile:1

# ---- Builder stage -------------------------------------------------------
# git + ca-certificates are needed here because the node-roon-api* deps are
# git dependencies (github:RoonLabs/...). They are installed only in this
# stage and never leak into the runtime image.
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching. Prefer a reproducible `npm ci`
# from the lockfile; fall back to `npm install` if no lockfile is present.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    else \
        npm install --omit=dev; \
    fi

# Application source (only what the runtime actually serves/runs).
COPY src ./src
COPY public ./public

# ---- Runtime stage -------------------------------------------------------
# Slim image WITHOUT git or build tooling. Node 22 provides the built-in
# node:sqlite module, so no native compilation is required.
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/meltface-80/MusicD-Shortcuts" \
      org.opencontainers.image.title="MusicD Shortcuts" \
      org.opencontainers.image.description="Roon extension that plays random albums via shareable webhooks for iOS Shortcuts."

WORKDIR /app

# Bring in node_modules + src + public + package.json from the builder.
COPY --from=builder /app ./

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# /data holds Roon's config.json (pairing token) and the SQLite webhooks.db.
# Persist it as a volume so pairing + webhooks survive container recreation.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# curl may be absent from the slim image, so probe with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
