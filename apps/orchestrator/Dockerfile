FROM node:20-slim AS build
WORKDIR /repo
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @vita/protocol build && pnpm --filter @vita/mcp-1hms build && pnpm --filter @vita/orchestrator build
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
EXPOSE 8081
CMD ["node", "dist/index.js"]
