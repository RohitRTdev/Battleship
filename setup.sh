#!/bin/sh

set -eu

setup_env() {
  if [ ! -f ".env" ]; then
    echo "Creating local environment file..."
    cp ".env.example" ".env"
  fi
  if ! grep -q '^JWT_SECRET=.' ".env"; then
    secret=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
    echo "JWT_SECRET=$secret" >> ".env"
  fi
  if ! grep -q '^POSTGRES_PASSWORD=.' ".env"; then
    password=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
    if grep -q '^POSTGRES_PASSWORD=' ".env"; then
      temporary_env=".env.tmp.$$"
      sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" ".env" > "$temporary_env"
      mv "$temporary_env" ".env"
    else
      echo "POSTGRES_PASSWORD=$password" >> ".env"
    fi
  fi
  if grep -q '^ENABLE_TEST_ROUTES=' ".env"; then
    temporary_env=".env.tmp.$$"
    sed 's/^ENABLE_TEST_ROUTES=.*/ENABLE_TEST_ROUTES=true/' ".env" > "$temporary_env"
    mv "$temporary_env" ".env"
  else
    echo "ENABLE_TEST_ROUTES=true" >> ".env"
  fi
  grep -q '^AWS_PROFILE=.' ".env" || echo "AWS_PROFILE=default" >> ".env"
  grep -q '^AWS_REGION=.' ".env" || echo "AWS_REGION=ap-south-1" >> ".env"
  grep -q '^PROD_STACK_NAME=.' ".env" || echo "PROD_STACK_NAME=battleship-prod" >> ".env"
}

load_production_env() {
  setup_env
  set -a
  . ./.env
  set +a
  : "${AWS_REGION:?AWS_REGION is required in .env}"
  : "${PROD_STACK_NAME:?PROD_STACK_NAME is required in .env}"
  AWS_PROFILE=${AWS_PROFILE:-default}
  export AWS_PROFILE AWS_REGION
}

check_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "$1 is required" >&2; exit 1; }
}

verify_aws() {
  check_command aws
  check_command terraform
  check_command docker
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "AWS authentication failed for profile '$AWS_PROFILE'. Run: aws sso login --profile $AWS_PROFILE" >&2
    exit 1
  fi
}

terraform_args() {
  echo "-var=aws_region=$AWS_REGION -var=name=$PROD_STACK_NAME"
}

up_dev() {
  setup_env
  echo "Installing dependencies..."
  npm install
  npm run build --workspace=@battleship/protocol
  docker compose up --build --detach --wait
  echo "Development environment: http://localhost:${GATEWAY_PORT:-8000}"
}

up_prod() {
  load_production_env
  verify_aws

  echo "Creating the production image repository..."
  terraform -chdir=infra/terraform/bootstrap init -input=false
  terraform -chdir=infra/terraform/bootstrap apply -auto-approve -input=false $(terraform_args)
  repository_url=$(terraform -chdir=infra/terraform/bootstrap output -raw repository_url)
  registry=${repository_url%%/*}
  revision=$(git rev-parse --short HEAD 2>/dev/null || echo build)
  image_tag="$revision-$(date +%Y%m%d%H%M%S)"
  backend_image="$repository_url:$image_tag"

  echo "Building and publishing backend image $backend_image..."
  # Use an isolated Docker config for ECR. This avoids depending on the host's
  # Docker Desktop credential helper, which can be unavailable or broken when
  # this script is run from Git Bash on Windows.
  temporary_docker_config=$(mktemp -d "${TMPDIR:-/tmp}/battleship-docker.XXXXXX")
  cleanup_docker_config() {
    rm -f "$temporary_docker_config/config.json" "$temporary_docker_config/ecr-password"
    rmdir "$temporary_docker_config" 2>/dev/null || true
  }
  trap cleanup_docker_config EXIT
  trap 'cleanup_docker_config; exit 1' HUP INT TERM
  # Do not call `docker login`: some Docker Desktop installations invoke their
  # broken Windows credential helper even when --config points elsewhere.
  aws ecr get-login-password > "$temporary_docker_config/ecr-password"
  ECR_REGISTRY="$registry" ECR_PASSWORD_FILE="$temporary_docker_config/ecr-password" DOCKER_AUTH_FILE="$temporary_docker_config/config.json" \
    node -e 'const fs=require("node:fs");const password=fs.readFileSync(process.env.ECR_PASSWORD_FILE,"utf8").trim();if(!password)throw new Error("AWS returned an empty ECR password");const auth=Buffer.from(`AWS:${password}`).toString("base64");fs.writeFileSync(process.env.DOCKER_AUTH_FILE,JSON.stringify({auths:{[process.env.ECR_REGISTRY]:{auth}}}),{mode:0o600})'
  rm -f "$temporary_docker_config/ecr-password"
  docker build --file apps/raft-node/Dockerfile --target production --tag "$backend_image" .
  docker --config "$temporary_docker_config" push "$backend_image"
  cleanup_docker_config
  trap - EXIT HUP INT TERM

  echo "Deploying AWS application resources..."
  terraform -chdir=infra/terraform/app init -input=false
  terraform -chdir=infra/terraform/app apply -auto-approve -input=false $(terraform_args) -var="backend_image=$backend_image"

  public_url=$(terraform -chdir=infra/terraform/app output -raw public_url)
  user_pool_id=$(terraform -chdir=infra/terraform/app output -raw cognito_user_pool_id)
  app_client_id=$(terraform -chdir=infra/terraform/app output -raw cognito_app_client_id)

  mkdir -p .deployment
  PROD_URL="$public_url" PROD_POOL="$user_pool_id" PROD_CLIENT="$app_client_id" node -e "require('node:fs').writeFileSync('.deployment/prod.json', JSON.stringify({url:process.env.PROD_URL,region:process.env.AWS_REGION,userPoolId:process.env.PROD_POOL,userPoolClientId:process.env.PROD_CLIENT},null,2))"
  PROD_URL="$public_url" node -e "Promise.all([fetch(process.env.PROD_URL + '/config.json'),fetch(process.env.PROD_URL + '/api/backend/player/state')]).then(async ([config,api])=>{if(!config.ok||api.status!==401)throw new Error('production smoke test failed');console.log('Production smoke test passed')}).catch(error=>{console.error(error);process.exit(1)})"
  echo "Production deployment complete: $public_url"
}

down_dev() {
  docker compose down --remove-orphans
}

down_prod() {
  load_production_env
  verify_aws
  if [ ! -f "infra/terraform/app/terraform.tfstate" ]; then
    echo "No local production Terraform state was found; refusing an unscoped deletion." >&2
    exit 1
  fi
  terraform -chdir=infra/terraform/app destroy -auto-approve -input=false $(terraform_args) -var="backend_image=destroy"
  terraform -chdir=infra/terraform/bootstrap destroy -auto-approve -input=false $(terraform_args)
  rm -rf .deployment
  echo "Production resources and data were deleted."
}

reset_dev() {
  docker compose down --volumes --remove-orphans
  docker image prune --force
  npm run clean
  rm -rf runtime node_modules .env coverage .vite __pycache__ scripts/__pycache__ scripts/common/__pycache__
}

usage() {
  echo "Usage:"
  echo "  ./setup.sh up          Start development at localhost:8000"
  echo "  ./setup.sh down        Stop development"
  echo "  ./setup.sh up prod     Build and deploy to AWS"
  echo "  ./setup.sh down prod   Permanently delete the AWS deployment"
  echo "  ./setup.sh reset       Delete generated development data"
}

command=${1:-help}
environment=${2:-dev}
case "$command:$environment" in
  up:dev) up_dev ;;
  down:dev) down_dev ;;
  up:prod) up_prod ;;
  down:prod) down_prod ;;
  reset:dev) reset_dev ;;
  help:dev) usage ;;
  *) usage >&2; exit 1 ;;
esac
