# Battleship developer guide

This guide describes the checked-out `master` branch, which implements the shared PostgreSQL configuration. The separate `config-2` branch uses etcd and has a different backend structure; check that branch's README and source when working there. Despite the `raft-node` directory name, the backend described here does not implement Raft.

## How a request moves through the system

The React frontend calls the gateway, which routes authentication requests to the local auth service and game requests to a backend replica. The backend validates the access token, handles the API request and uses PostgreSQL to coordinate shared game state. The game engine checks rules and produces transitions; the repository persists them in transactions. Database notifications wake long-poll requests on backend replicas. Finished matches are processed by an archive worker and stored on disk locally or in S3 in production.

In production, Cognito replaces the local authentication service and the backend serves the built frontend. AWS infrastructure uses ECS/Fargate, a load balancer and RDS PostgreSQL. See `README.md` for current setup and deployment commands.

## Repository layout

### `apps/frontend/`

The browser application uses React, TypeScript and Vite.

- `src/main.tsx`: application entry point, screens and interactions for authentication, lobby, matchmaking, fleet placement, gameplay, reconnect and match history.
- `src/api.ts`: authenticated HTTP client, request timeouts, errors and game API calls.
- `src/auth.ts`: authentication provider interface and local/Cognito implementations, including session handling.
- `src/routing.tsx`: routes and guards for sessions, matchmaking and active games.
- `src/fleet.ts`: client-side fleet placement helpers, validation and automatic placement. Server validation remains authoritative.
- `src/styles.css`: application styles; `vite-env.d.ts` supplies Vite types.
- `index.html`, `vite.config.ts`, `tsconfig.json` and `package.json`: entry page, development/build configuration and dependencies.
- `Dockerfile`: frontend container build.

### `apps/raft-node/`: game backend

- `src/main.ts`: starts the HTTP service, configures authentication, connects to PostgreSQL, runs migrations, starts update and background workers, and handles health and shutdown. In production it also serves the frontend.
- `src/http/game-router.ts`: HTTP routes, request validation, error mapping and player-facing responses for games, matchmaking, updates and history.
- `src/game/types.ts`: internal game state, commands, events and result types.
- `src/game/rules.ts`: board and fleet rules, coordinate checks and fleet validation.
- `src/game/state-machine.ts`: game creation, command transitions, turn/placement deadlines and command replay.
- `src/game/projection.ts`: creates a player-specific view without exposing the opponent's hidden fleet.
- `src/game/errors.ts`: domain errors and result helpers; `index.ts` re-exports the game module.
- `src/database/game-repository.ts`: PostgreSQL-backed game operations, transactions and locks, event persistence, matchmaking, presence, timeouts and player views.
- `src/database/migrations.ts`: database schema migrations, coordinated across replicas.
- `src/database/update-bus.ts`: PostgreSQL notification listener and local subscriptions used to wake waiting requests and workers.
- `src/archive/archive-worker.ts`: background processing for completed-match archive jobs.
- `src/archive/match-archive.ts`: archive interface and player-specific history/statistics helpers.
- `src/archive/local-match-archive.ts` and `s3-match-archive.ts`: filesystem and S3 archive implementations; `index.ts` chooses an implementation for the environment.
- `Dockerfile`, `package.json` and `tsconfig.json`: container, dependencies and TypeScript build.

### `apps/auth-service/`: local authentication

`src/main.ts` implements development registration, login, HTTP health checks and optional user-management test routes using SQLite. `src/types.ts` defines its data types. Production authentication uses Cognito instead. The local service is for development, not a production authentication system.

### `packages/`: shared code

- `game-contract/src/index.ts`: shared API types, statuses, error codes and player-facing game/history structures used by frontend and backend.
- `auth-token/src/index.ts`: token creation, local JWT verification, Cognito verification and Express authorization middleware.
- Each package has its own `package.json` and TypeScript configuration; the root workspace build compiles them before dependent applications.

### `infra/`: routing and AWS resources

- `nginx/default.conf.template` and `nginx/Dockerfile`: local gateway configuration and image.
- `terraform/bootstrap/main.tf`: bootstrap resources for the image repository.
- `terraform/app/main.tf` and `variables.tf`: AWS application resources and configurable inputs. Consult these files for the exact deployed topology and defaults.

### `scripts/`: test clients

- `auth_users.py`: local test user management and Cognito bot provisioning.
- `play_bot.py`: starts a game for a human to play against a bot.
- `simulate_game.py`: runs automated bot games.
- `load_test.py`: production load generation, result collection and graph generation; `--plot-only` regenerates graphs from saved results.
- `common/auth_client.py`, `bot_names.py` and `game_bot.py`: shared authentication, bot identity and game-client utilities; `common/__init__.py` marks the package.
- `bot_names.txt`: reusable bot names. `requirements.txt`: Python dependencies.

Run a script with `--help` for its exact arguments. The README describes local and production setup; cloud load testing creates test resources and generates traffic.

## Root files and runtime data

- `setup.sh`: installs/builds and starts the local stack, deploys or destroys AWS resources, and offers local reset. Production teardown and reset delete data; read the script before using them.
- `compose.yaml`: local frontend, gateway, auth, PostgreSQL and backend replica services.
- `.env.example`: starter environment options; setup creates `.env` and secrets as needed.
- `package.json` and `package-lock.json`: npm workspace scripts and dependency lock; `tsconfig.base.json` provides shared TypeScript settings.
- `README.md`: prerequisites, operational commands, timeout settings and bot usage.
- `CloudHack.pdf` and `prd.md`: original project proposal and its Markdown version. The proposal includes superseded architecture ideas.
- `doc.pdf`: setup/testing handoff document, where present.
- `runtime/`, `.deployment/`, build outputs and load-test results are generated local or deployment artifacts rather than application source.

## Where to make common changes

- Game rules or transitions: `apps/raft-node/src/game/`; update the shared contract and UI when the public behavior changes.
- API endpoints or response errors: `http/game-router.ts`, with persistence changes in `database/game-repository.ts` as needed.
- Cross-replica state, locking or schema: `database/`; preserve atomicity and player privacy.
- UI screens or authentication: `apps/frontend/src/` and the corresponding shared contract.
- Completed-game retention or archive output: `archive/` and archive-related database handling.
- Deployment or local topology: `compose.yaml`, the application Dockerfiles, `setup.sh` and `infra/`.

For setup, use `./setup.sh up`; `npm run build` builds the workspace separately. Keep local secrets and production state out of commits.
