#!/bin/sh
# Plays games on a throwaway three-node etcd cluster while killing its leader.
set -eu

cd "$(dirname "$0")/.."

run=$$
network="battleship-failover-$run"
names="etcd-a-$run etcd-b-$run etcd-c-$run"
cluster=""
for name in $names; do cluster="$cluster${cluster:+,}$name=http://$name:2380"; done

cleanup() {
  # shellcheck disable=SC2086
  docker rm --force $names >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Fixed host ports: a restarted container would otherwise get a new random one and become unreachable.
free_port() {
  node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"
}

docker network create "$network" >/dev/null
for name in $names; do
  docker run --detach --name "$name" --network "$network" --publish "127.0.0.1:$(free_port):2379" quay.io/coreos/etcd:v3.6.15 \
    etcd --name "$name" \
      --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls "http://$name:2379" \
      --listen-peer-urls http://0.0.0.0:2380 --initial-advertise-peer-urls "http://$name:2380" \
      --initial-cluster "$cluster" --initial-cluster-state new --initial-cluster-token "failover-$run" >/dev/null
done

members=""
for name in $names; do
  until docker exec "$name" etcdctl endpoint health >/dev/null 2>&1; do sleep 0.5; done
  port=$(docker port "$name" 2379/tcp | head -n 1 | sed 's/.*://')
  members="$members${members:+,}$name=127.0.0.1:$port"
done

TEST_ETCD_CLUSTER="$members" npx tsx --test "$@" test/failover/*.test.ts
