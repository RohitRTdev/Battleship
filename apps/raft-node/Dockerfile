FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/raft-node/package.json apps/raft-node/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace=@battleship/raft-node --workspace=@battleship/protocol --include-workspace-root=false

FROM dependencies AS dev
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/raft-node apps/raft-node
RUN npm run build --workspace=@battleship/protocol
CMD ["npm", "run", "dev", "--workspace=@battleship/raft-node"]

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/raft-node apps/raft-node
RUN npm run build --workspace=@battleship/protocol \
    && npm run build --workspace=@battleship/raft-node \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS production
WORKDIR /workspace
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/apps/raft-node/package.json apps/raft-node/package.json
COPY --from=build /workspace/apps/raft-node/dist apps/raft-node/dist
COPY --from=build /workspace/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY infra/node/production-entrypoint.sh /usr/local/bin/battleship-entrypoint
RUN chmod +x /usr/local/bin/battleship-entrypoint \
    && chown -R node:node /workspace
ENTRYPOINT ["battleship-entrypoint"]
CMD ["node", "apps/raft-node/dist/main.js"]
