# FleetSync product requirements

FleetSync is a two-player Battleship game. Each player places five ships on a 10 × 10 board and takes turns firing at the opponent. The server validates each move, decides the outcome and controls which cells each player can see.

## Gameplay and service requirements

| ID | Player or operator behavior |
| --- | --- |
| FR-1 | A signed-in player can create a private game, join one by code, or enter the matchmaking queue. Matchmaking pairs waiting players in queue order and tracks each player's active assignment. |
| FR-2 | Each fleet contains straight ships of lengths 5, 4, 3, 3 and 2. The server checks their positions, boundaries, overlap and spacing before accepting placement. |
| FR-3 | The server checks whose turn it is and whether the target is legal. An accepted shot updates the board and match version together. Sinking the last opposing ship wins the game. |
| FR-4 | Each player receives a view of their own fleet and the results of their shots. During play, unrevealed enemy ship positions stay hidden. The browser requests updates over HTTP using the last game version it saw. |
| FR-5 | On reconnect, the client retrieves the player's current assignment and game view, then resumes polling for updates. |
| FR-6 | Fleet and turn commands carry a command ID and an expected game version. The backend records command results and checks versions inside a database transaction so a retry cannot apply the same move twice. |
| FR-7 | Finished matches are archived. Players can open their profile to see match history and statistics and inspect an individual match. |
| FR-8 | Operators can run the game locally with Docker Compose or deploy it to AWS with the setup script. The load-test client records results and generates plots. |
| FR-9 | The game API verifies access tokens and checks match membership before returning a private board. When rate limiting is enabled, the replicas share a limit of 20 command requests per player in a rolling second. |
| FR-10 | A player can play against a bot. The simulation client can also run bot matches with a seed for reproducible bot decisions. |

By default, players share a 60-second fleet-placement deadline and have 30 seconds per turn, with a 500 ms server-side delivery grace period. Operators can disable both deadlines with `DISABLE_TIMEOUT` in `.env`.

## Architecture and deployment

The React client sends game commands and long-polls for updates. Backend replicas store active games, matchmaking assignments and command results in shared PostgreSQL. A database notification wakes a waiting replica, which reads the current state and returns the requesting player's view.

| Component | Local development | AWS production |
| --- | --- | --- |
| Authentication | Local registration and login service backed by SQLite | Amazon Cognito user pool |
| Application | Nginx routes requests to the frontend and backend services in Docker Compose | A load balancer routes traffic to ECS/Fargate tasks that serve the built frontend and game API |
| Game storage | PostgreSQL container | Amazon RDS for PostgreSQL |
| Match archive | Local filesystem | Amazon S3 |

## Verification

The Python test clients exercise command replay, timeout recovery, rate limiting and error responses. The load-test client reports request latency, including p95 and p99, for each run. See [the developer guide](dev.md) for the relevant components and [the README](README.md) for setup and bot commands.
