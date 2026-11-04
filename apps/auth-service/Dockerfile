FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
COPY packages/auth-token/package.json packages/auth-token/package.json
RUN npm ci --workspace=@battleship/auth-service --workspace=@battleship/auth-token --include-workspace-root=false

FROM dependencies AS dev
COPY tsconfig.base.json ./
COPY packages/auth-token packages/auth-token
COPY apps/auth-service apps/auth-service
RUN npm run build --workspace=@battleship/auth-token
CMD ["npm", "run", "dev", "--workspace=@battleship/auth-service"]
