FROM node:20-slim AS build
WORKDIR /repo
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @vita/protocol build && pnpm --filter @vita/orchestrator build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/orchestrator/dist ./dist
COPY --from=build /repo/apps/orchestrator/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/protocol/dist ./node_modules/@vita/protocol/dist
COPY --from=build /repo/packages/protocol/package.json ./node_modules/@vita/protocol/package.json
EXPOSE 8081
CMD ["node", "dist/index.js"]
