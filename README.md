# Battleship service scaffold

This repository contains a Docker-first local scaffold for the Battleship system. It deliberately contains only health, storage, routing, and gRPC connectivity placeholders.

## Topology

- One public nginx gateway on `http://localhost:8000`
- One React frontend
- One authentication service
- Three control-plane nodes
- Three private backend Raft nodes
- One SQLite database per database-backed container

Only the gateway publishes a host port. All HTTP and gRPC communication between services uses the `battleship-net` Docker network.

## Start and stop development

```bash
docker compose up --build --detach --wait
docker compose down --remove-orphans
```

Development runs TypeScript through `tsx --watch` and React through Vite. Source directories are bind-mounted; dependencies stay inside the images. Visit `http://localhost:8000`.

## Start and stop the production-like environment

```bash
docker compose -f compose.prod.yaml up --build --detach --wait
docker compose -f compose.prod.yaml down --remove-orphans
```

Production-like containers run compiled JavaScript. The frontend is built by Vite and served by an internal nginx container.

## Placeholder routes

- `GET /` serves the frontend.
- `GET /api/auth/_stub` reaches the auth service.
- `GET /api/backend/_stub` is load-balanced across the control-plane nodes.
- `GET /gateway-healthz` checks the public gateway.

The backend Raft nodes intentionally have no public route.

## Persistence

SQLite files are created below `runtime/` and are ignored by Git. Compose teardown preserves them. Delete that directory only when an explicit full data reset is intended.

## Workspace commands

```bash
npm ci
npm run build
npm run typecheck
npm run clean
```

Use `npm install` when adding or changing dependencies. Docker builds use `npm ci` so dependency versions match `package-lock.json` exactly.

