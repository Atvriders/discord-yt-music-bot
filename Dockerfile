# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 CACHE_DIR=/data/cache PATH="/usr/local/bin:${PATH}"
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates curl unzip gosu \
    && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" && yt-dlp --version
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- --yes && deno --version
WORKDIR /app
RUN useradd --create-home --uid 10001 app && mkdir -p "${CACHE_DIR}" && chown -R app:app "${CACHE_DIR}" /app
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# NOTE: no `USER app` here — the entrypoint starts as root only to chown the
# mounted cache volume (which may be root-owned), then drops to 'app' via gosu.
VOLUME ["/data/cache"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
