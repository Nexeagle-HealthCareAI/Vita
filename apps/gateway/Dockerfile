FROM node:20-slim AS build
WORKDIR /repo

# Manifests only, first -- so this layer's cache key doesn't depend on any source file.
# Previously `COPY . .` before install meant a change to ANY file anywhere in the repo
# (even apps/web-demo or docs/) invalidated the cached install layer below, defeating
# deploy.yml's GHA layer cache (cache-from/cache-to: type=gha). pnpm install needs every
# workspace member's package.json present to validate against pnpm-lock.yaml, even
# though only @vita/protocol/@vita/gateway actually get built below.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/web-demo/package.json apps/web-demo/
COPY packages/protocol/package.json packages/protocol/
COPY packages/mcp-1hms/package.json packages/mcp-1hms/
COPY packages/rag/package.json packages/rag/
COPY packages/web-sdk/package.json packages/web-sdk/
COPY tools/load-test/package.json tools/load-test/
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @vita/protocol build && pnpm --filter @vita/gateway build
# `pnpm deploy` resolves every workspace dependency (e.g. @vita/protocol's own
# runtime deps like zod, which aren't hoisted to the repo-root node_modules)
# into real files rather than symlinks -- the correct way to produce a
# standalone, Docker-copyable output for one package out of a pnpm workspace.
RUN pnpm --filter @vita/gateway deploy --prod /prod/gateway

# pnpm deploy's node_modules symlinks are absolute, so the output must land at
# the exact same path in this stage as it did in the build stage above.
FROM node:20-slim
WORKDIR /prod/gateway
ENV NODE_ENV=production
COPY --from=build /prod/gateway /prod/gateway
EXPOSE 8080
CMD ["node", "dist/index.js"]
