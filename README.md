## Requirements

- Docker v28
- Node.js v24, npm v11
- Python v3.13
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

Start with production-safe settings:

```sh
./setup.sh up prod
```

Stop the project:

```sh
./setup.sh down
```

Show command usage:

```sh
./setup.sh help
```

## Test bots

The `scripts/` folder contains reusable Python helpers and bot scripts for exercising the running services.

For Example: Run authentication smoke test

```sh
python scripts/auth_smoke.py
```

By default, it concurrently registers and logs in 50 uniquely named bots, then prints all registered user IDs, usernames, and creation timestamps.

Run a larger swarm:

```sh
python scripts/auth_smoke.py --count 120 --workers 40
```
