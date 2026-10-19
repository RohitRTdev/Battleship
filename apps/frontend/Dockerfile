FROM node:24-bookworm-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci --workspace=@battleship/frontend --include-workspace-root=false

FROM dependencies AS dev
COPY apps/frontend apps/frontend
CMD ["npm", "run", "dev", "--workspace=@battleship/frontend"]

FROM dependencies AS build
COPY apps/frontend apps/frontend
RUN npm run build --workspace=@battleship/frontend

FROM nginx:stable-alpine AS production
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/frontend/dist /usr/share/nginx/html

