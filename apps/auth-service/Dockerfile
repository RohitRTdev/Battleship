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
