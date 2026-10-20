#!/bin/sh

set -eu

test_routes_enabled=true
for argument in "$@"; do
  if [ "$argument" = "prod" ]; then
    test_routes_enabled=false
    break
  fi
done

setup_env() {
  if [ ! -f ".env" ]; then
    echo "Creating local environment file..."
    cp ".env.example" ".env"
  fi

  if ! grep -q '^JWT_SECRET=.' ".env"; then
    echo "Adding JWT secret to local environment file..."
    secret=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
    echo "JWT_SECRET=$secret" >> ".env"
  fi

  if grep -q '^ENABLE_TEST_ROUTES=' ".env"; then
    temporary_env=".env.tmp.$$"
    sed "s/^ENABLE_TEST_ROUTES=.*/ENABLE_TEST_ROUTES=$test_routes_enabled/" ".env" > "$temporary_env"
    mv "$temporary_env" ".env"
  else
    echo "ENABLE_TEST_ROUTES=$test_routes_enabled" >> ".env"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  ./setup.sh up [prod]  Start the development or production stack
  ./setup.sh down       Stop the stack and preserve database data
  ./setup.sh reset      Stop the stack and remove all generated artifacts (This deletes the database too..)
  ./setup.sh help       Show this help
EOF
}

reset_data() {
  echo "Stopping containers and removing Docker volumes..."
  docker compose down --volumes --remove-orphans

  echo "Removing dangling Docker images..."
  docker image prune --force

  echo "Removing build artifacts..."
  npm run clean

  echo "Removing dependencies and generated local state..."
  rm -rf runtime node_modules .env coverage .vite __pycache__ \
    scripts/__pycache__ scripts/common/__pycache__
}

command=${1:-help}

case "$command" in
  up)
    setup_env
    echo "Installing host dependencies..."
    npm install
    echo "Generating protocol files for the host workspace..."
    npm run build --workspace=@battleship/protocol
    echo "Starting Docker Compose..."
    docker compose up --build --detach --wait
    ;;
  down)
    echo "Stopping containers..."
    docker compose down --remove-orphans
    ;;
  reset)
    reset_data
    ;;
  help)
    usage
    ;;
  *)
    echo "Invalid command: $command" >&2
    usage >&2
    exit 1
    ;;
esac
