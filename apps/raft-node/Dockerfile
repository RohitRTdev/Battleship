FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/raft-node/package.json apps/raft-node/package.json
COPY packages/auth-token/package.json packages/auth-token/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace=@battleship/raft-node --workspace=@battleship/auth-token --workspace=@battleship/protocol --include-workspace-root=false

FROM dependencies AS dev
COPY tsconfig.base.json ./
COPY packages/auth-token packages/auth-token
COPY packages/protocol packages/protocol
COPY apps/raft-node apps/raft-node
RUN npm run build --workspace=@battleship/protocol \
    && npm run build --workspace=@battleship/auth-token
CMD ["npm", "run", "dev", "--workspace=@battleship/raft-node"]

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/auth-token packages/auth-token
COPY packages/protocol packages/protocol
COPY apps/raft-node apps/raft-node
RUN npm run build --workspace=@battleship/protocol \
    && npm run build --workspace=@battleship/auth-token \
    && npm run build --workspace=@battleship/raft-node \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS production
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/apps/raft-node/package.json apps/raft-node/package.json
COPY --from=build /workspace/apps/raft-node/dist apps/raft-node/dist
COPY --from=build /workspace/packages/auth-token/package.json packages/auth-token/package.json
COPY --from=build /workspace/packages/auth-token/dist packages/auth-token/dist
COPY --from=build /workspace/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
RUN chown -R node:node /workspace
USER node
CMD ["node", "apps/raft-node/dist/main.js"]
