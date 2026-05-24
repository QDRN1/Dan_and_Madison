# ── Build stage: compile shared + server + web ───────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm install

COPY packages ./packages
COPY apps ./apps
COPY brand ./brand
RUN npm run build

# Prune dev deps for runtime
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# docker CLI + compose plugin so the admin console can inspect/restart sibling
# containers and the setup wizard can recreate the feeders to apply new keys.
ARG COMPOSE_VERSION=v2.29.7
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates curl \
    && mkdir -p /usr/libexec/docker/cli-plugins \
    && case "$(uname -m)" in \
         x86_64) C=x86_64 ;; \
         aarch64|arm64) C=aarch64 ;; \
         armv7l) C=armv7 ;; \
         *) C="$(uname -m)" ;; \
       esac \
    && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${C}" \
         -o /usr/libexec/docker/cli-plugins/docker-compose \
    && chmod +x /usr/libexec/docker/cli-plugins/docker-compose \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/brand ./brand

EXPOSE 8080
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/qdrn-radar.db
ENV WEB_DIST=/app/apps/web/dist
ENV BRAND_DIR=/app/brand

CMD ["node", "apps/server/dist/index.js"]
