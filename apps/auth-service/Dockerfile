FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
COPY packages/auth-token/package.json packages/auth-token/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --workspace=@battleship/auth-service --workspace=@battleship/auth-token --workspace=@battleship/protocol --include-workspace-root=false

FROM dependencies AS dev
COPY tsconfig.base.json ./
COPY packages/auth-token packages/auth-token
COPY packages/protocol packages/protocol
COPY apps/auth-service apps/auth-service
RUN npm run build --workspace=@battleship/protocol \
    && npm run build --workspace=@battleship/auth-token
CMD ["npm", "run", "dev", "--workspace=@battleship/auth-service"]

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/auth-token packages/auth-token
COPY packages/protocol packages/protocol
COPY apps/auth-service apps/auth-service
RUN npm run build --workspace=@battleship/protocol \
    && npm run build --workspace=@battleship/auth-token \
    && npm run build --workspace=@battleship/auth-service \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS production
WORKDIR /workspace
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/node_modules node_modules
COPY --from=build /workspace/apps/auth-service/package.json apps/auth-service/package.json
COPY --from=build /workspace/apps/auth-service/dist apps/auth-service/dist
COPY --from=build /workspace/packages/auth-token/package.json packages/auth-token/package.json
COPY --from=build /workspace/packages/auth-token/dist packages/auth-token/dist
COPY --from=build /workspace/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
COPY infra/node/production-entrypoint.sh /usr/local/bin/battleship-entrypoint
RUN chmod +x /usr/local/bin/battleship-entrypoint \
    && chown -R node:node /workspace
ENTRYPOINT ["battleship-entrypoint"]
CMD ["node", "apps/auth-service/dist/main.js"]
