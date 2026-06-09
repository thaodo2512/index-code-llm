# syntax=docker/dockerfile:1

# --- build stage: compile TypeScript, then prune to production deps ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime stage: bundles CodeGraph so nothing is installed on the host ---
FROM node:22-bookworm-slim AS runtime
# Pin to a validated CodeGraph release for reproducible images (override at build).
ARG CODEGRAPH_VERSION=0.9.4
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @colbymchenry/codegraph@${CODEGRAPH_VERSION} \
  && npm cache clean --force
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh /app/dist/cli.js \
  && ln -s /app/dist/cli.js /usr/local/bin/codegraph-workspace
ENV NODE_ENV=production \
    CODEGRAPH_WORKSPACE_CONFIG=/config/workspace.json
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8765/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve", "--http", "--host", "0.0.0.0", "--port", "8765"]
