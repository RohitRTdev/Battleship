## Requirements

- Docker v28
- Node.js v24, npm v11
- Python v3.13, available through the `python` command
- AWS CLI v2 and Terraform v1.7+ for production deployment
- A POSIX environment to run commands (Git bash, WSL, Msys2, Linux, MacOS)

## Run the project

Start the development environment:

```sh
./setup.sh up
```

This creates `.env` when needed, generates a JWT secret, enables development test routes, builds the containers, and waits for them to become healthy. The application is then available at:

```text
http://localhost:8000
```

Deploy the production application to AWS:

```sh
aws login
./setup.sh up prod
```

Following this, you may access the public url mentioned in output log of the script, to play the game

To stop development build:

```sh
./setup.sh down
```

If you have deployed application (./setup.sh up prod), then you can terminate the resources by calling:
```sh
./setup.sh down prod
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

On AWS (`./setup.sh up prod`), three shared EC2 hosts run the control-plane cluster and the data clusters. Each host runs one member of every cluster, in a separate container with its own data directory and ports. The hosts are spread across three availability zones; losing one host affects every cluster, but each retains two members. Set `etcd_data_cluster_count` for more data clusters. Hosts are reachable through SSM Session Manager. Run the cluster CLI inside a backend task with ECS Exec (needs the AWS Session Manager plugin):

```sh
task=$(aws ecs list-tasks --cluster battleship-prod --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster battleship-prod --task "$task" --container backend --interactive \
  --command "node apps/game-service/dist/cli/clusters.js list"
```

Locally, `compose.yaml` runs each etcd member in its own container, with data in `runtime/etcd/`. To inspect the control cluster:

```sh
docker exec battleship-etcd-1 etcdctl \
  --endpoints=http://etcd-1:2379,http://etcd-2:2379,http://etcd-3:2379 endpoint status -w table
```

To try a failover, stop a member (for example, `docker kill battleship-etcd-1`), then bring it back with `docker start battleship-etcd-1`. Requests in flight during a leader election may fail temporarily.

## Turn timeout

By default, both players share 60 seconds to submit their fleets; the game is cancelled if either player has not submitted in time. Each active turn lasts 30 seconds, with a 500 ms server-side delivery grace period. A player who runs out of time loses the match. To disable the timer for testing, set `DISABLE_TIMEOUT=true` in `.env` before starting development or deploying production. The setting applies to all backend instances; restart the deployment after changing it. Use fresh game data when changing this setting.

## Test bots

To use the test scripts in production (cloud deployed), first run:
```sh
python -m pip install -r scripts/requirements.txt
```

After `./setup.sh up prod` completes, provision the Cognito bot accounts once
using an authenticated AWS profile:

```sh
python scripts/auth_users.py --prod provision-bots
```

This script creates 1000 bot accounts within the cloud deployment.

Then run either one interactive bot or a simulated game environment:

```sh
python scripts/play_bot.py --prod
python scripts/simulate_game.py --prod
```
Use `play_bot.py` to let a bot start a game. You may then join the game using the printed game code.

You may check the script doc to see what each one does

> [!IMPORTANT]
> These scripts work with both local and cloud deployments. Add the `--prod`
> option to target the cloud deployment. Without `--prod`, a script assumes the
> application is running locally at `http://localhost:8000`.
