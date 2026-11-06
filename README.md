## Requirements

- Docker v28
- Node.js v24, npm v11
- Python v3.13, available through the `python` command
- AWS CLI v2 and Terraform v1.7+ for production deployment
- A POSIX environment to run commands (Git bash, WSL, Msys2, Linux, MacOS)

## Run the project

Start the development environment:

```sh
./setup.sh up etcd
```

This creates `.env` when needed, generates a JWT secret, enables development test routes, builds the containers, and waits for them to become healthy. The application is then available at:

```text
http://localhost:8000
```

Deploy the production application to AWS:

```sh
aws login
./setup.sh up prod etcd
```

Following this, you may access the public url mentioned in output log of the script, to play the game

To stop development build:

```sh
./setup.sh down etcd
```

If you have deployed application (./setup.sh up prod etcd), then you can terminate the resources by calling:
```sh
./setup.sh down prod etcd
```
Note: This will also destroy the etcd clusters and the user pool, which means game data and user login data will be gone.

Show command usage:

```sh
./setup.sh help
```

## Game store: etcd

The three backend nodes keep games in etcd: a three-node control-plane cluster (players, matchmaking, where each game lives) and two three-node data clusters (a and b) that hold the games. Each cluster replicates every write with Raft, so it survives losing any one of its nodes. Each game lives on one data cluster; backends find it through its route on the control plane.

Data clusters are registered on the control plane. The first backend to start seeds the registry (from `ETCD_DATA_CLUSTERS`, or one cluster `main`); after that, manage clusters with the CLI, here run inside a backend container:

```sh
cli() { docker exec battleship-backend-node-1 npm run --silent clusters --workspace=@battleship/game-service -- "$@"; }
cli list                                   # state, endpoints, unfinished games, pending archive jobs
cli register c host-1:2379,host-2:2379     # new games start going to c; every backend connects to it
cli drain b                                # no new games on b; its games carry on
cli activate b                             # undo a drain
cli remove b                               # retire a drained cluster once it has no unfinished games or archive jobs
```

On AWS (`./setup.sh up prod etcd`), the control-plane cluster and the two data clusters run on EC2: nine nodes, with each cluster spread over three availability zones (set `etcd_data_cluster_count` for more data clusters), reachable through SSM Session Manager. On AWS, run the cluster CLI inside a backend task with ECS Exec (needs the AWS Session Manager plugin):

```sh
task=$(aws ecs list-tasks --cluster battleship-prod --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster battleship-prod --task "$task" --container backend --interactive \
  --command "node apps/game-service/dist/cli/clusters.js list"
```

**AWS vCPU limit.** An account on AWS's free plan may run at most 8 vCPUs of regular EC2 instances, and every instance type the free plan allows has 2 vCPUs, so at most 4 machines. The nine machines (18 vCPUs) don't fit: AWS refuses most of them and the backends never start. Such an account must deploy the co-located layout instead, which runs every cluster on the same three machines, each on its own ports (control 2379, a 2381, b 2383):

```sh
TF_VAR_etcd_colocate=true ./setup.sh up prod etcd
```

The setting is not saved anywhere, so **pass `TF_VAR_etcd_colocate=true` on every deploy**, including redeploys. A plain `./setup.sh up prod etcd` against a co-located deployment would delete the three shared machines (and every game on them) to build nine separate ones, which the vCPU limit then refuses, leaving no control plane. The trade-off of co-locating is that losing one machine takes a member from every cluster at once.

Locally, `compose.yaml` runs the control plane as `etcd-1..3` and the data clusters as `data-a-1..3` and `data-b-1..3`, with their data in `runtime/etcd/`. To see the control plane and which node is its leader (for a data cluster, use e.g. `battleship-data-a-1` and `data-a-1..3`):

```sh
docker exec battleship-etcd-1 etcdctl \
  --endpoints=http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379 endpoint status -w table
```

To try a failover, stop a cluster's leader (e.g. `docker kill battleship-etcd-1`), keep playing or run `python scripts/game_bots.py`, then bring it back with `docker start battleship-etcd-1`. Requests in flight while the leader dies can fail with a 503 for about a second; no committed move is lost.

## Turn timeout

By default, both players share 60 seconds to submit their fleets; the game is cancelled if either player has not submitted in time. Each active turn lasts 30 seconds, with a 500 ms server-side delivery grace period. A player who runs out of time loses the match. To disable the timer for testing, set `DISABLE_TIMEOUT=true` in `.env` before starting development or deploying production. The setting applies to all backend instances; restart the deployment after changing it. Use fresh game data when changing this setting.

## Tests

```sh
npm test
```

Runs the game-service store tests against throwaway etcd containers (Docker required). The single-cluster and sharded layouts run the same suite in `apps/game-service/test/store-contract.ts`.

```sh
npm run test:failover --workspace=@battleship/game-service
```

Plays games on a throwaway three-node etcd cluster while repeatedly killing its leader, and checks that no move is lost, applied twice, or reported wrongly. It takes about a minute. `npm run test:failover:sharded --workspace=@battleship/game-service` does the same with a control-plane cluster and two data clusters, killing the leaders of all three in turn.

## Test bots

To use the test scripts in production (cloud deployed), first run:
```sh
python -m pip install -r scripts/requirements.txt
```

After `./setup.sh up prod etcd` completes, provision the Cognito bot accounts once
using an authenticated AWS profile:

```sh
python scripts/auth_users.py --prod provision-bots
```

This script creates 120 bot accounts within the cloud deployment.

Then run either one interactive bot or the concurrent game checks:

```sh
python scripts/play_bot.py --prod
python scripts/game_bots.py --prod
```
Use `play_bot.py` to let a bot start a game. You may then join the game using the printed game code.

You may check the script doc to see what each one does<br>
For Example: Run authentication smoke test

```sh
python scripts/auth_smoke.py
```

By default, it concurrently registers and logs in 50 uniquely named bots, then prints all registered user IDs, usernames, and creation timestamps.

Run a larger swarm:

```sh
python scripts/auth_smoke.py --count 120 --workers 40
```

> [!IMPORTANT]
> These scripts work with both local and cloud deployments. Add the `--prod`
> option to target the cloud deployment. Without `--prod`, a script assumes the
> application is running locally at `http://localhost:8000`.
