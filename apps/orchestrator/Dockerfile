FROM node:20-slim AS build
WORKDIR /repo

# Manifests only, first -- so this layer's cache key doesn't depend on any source file.
# Previously `COPY . .` before install meant a change to ANY file anywhere in the repo
# (even apps/web-demo or docs/) invalidated the cached install layer below, defeating
# deploy.yml's GHA layer cache (cache-from/cache-to: type=gha). pnpm install needs every
# workspace member's package.json present to validate against pnpm-lock.yaml, even
# though only a subset of packages actually get built below.
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
RUN pnpm --filter @vita/protocol build && pnpm --filter @vita/mcp-1hms build && pnpm --filter @vita/rag build && pnpm --filter @vita/orchestrator build
# `pnpm deploy` resolves every workspace dependency (e.g. @vita/protocol and
# @vita/mcp-1hms's own runtime deps like zod and @modelcontextprotocol/sdk,
# none of which are hoisted to the repo-root node_modules) into real files
# rather than symlinks -- the correct way to produce a standalone,
# Docker-copyable output for one package out of a pnpm workspace.
RUN pnpm --filter @vita/orchestrator deploy --prod /prod/orchestrator

# pnpm deploy's node_modules symlinks are absolute, so the output must land at
# the exact same path in this stage as it did in the build stage above.
FROM node:20-slim
WORKDIR /prod/orchestrator
ENV NODE_ENV=production
COPY --from=build /prod/orchestrator /prod/orchestrator
# node:20-slim ships a built-in non-root `node` user (uid 1000) for exactly this --
# no privileged port here (8081), so nothing needs root.
USER node
EXPOSE 8081
CMD ["node", "dist/index.js"]
