FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci --workspace=@battleship/frontend --include-workspace-root=false

FROM dependencies AS dev
COPY apps/frontend apps/frontend
CMD ["npm", "run", "dev", "--workspace=@battleship/frontend"]
