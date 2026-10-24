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
Note: This will also destroy the application database, which means game data and user login data will be gone.

Show command usage:

```sh
./setup.sh help
```

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

This script creates 120 bot accounts within the cloud deployment.

Then run either one interactive bot or the concurrent game checks:

```sh
python scripts/play_bot.py --prod
python scripts/game_bots.py --prod
```
Use play_bot.py to let a bot start a game. You may then join the game using the printed game code.

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
