#!/bin/sh
# Plays games on throwaway three-node etcd clusters while killing their leaders.
#   FAILOVER_LAYOUT=single  (default) one cluster serves as control plane and data cluster
#   FAILOVER_LAYOUT=sharded a control plane plus two data clusters, a and b
set -eu

cd "$(dirname "$0")/.."

run=$$
case "${FAILOVER_LAYOUT:-single}" in
  single) clusters="main" ;;
  sharded) clusters="control a b" ;;
  *) echo "FAILOVER_LAYOUT must be single or sharded" >&2; exit 1 ;;
esac

containers=""
networks=""
cleanup() {
  # shellcheck disable=SC2086
  [ -n "$containers" ] && docker rm --force $containers >/dev/null 2>&1 || true
  for network in $networks; do docker network rm "$network" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

# Fixed host ports: a restarted container would otherwise get a new random one and become unreachable.
free_port() {
  node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"
}

# TEST_ETCD_CLUSTERS lists the clusters as id:name=host,name=host|id:...; the first one is the control plane.
spec=""
for cluster in $clusters; do
  network="battleship-failover-$cluster-$run"
  docker network create "$network" >/dev/null
  networks="$networks $network"
  names="etcd-$cluster-1-$run etcd-$cluster-2-$run etcd-$cluster-3-$run"
  initial=""
  for name in $names; do initial="$initial${initial:+,}$name=http://$name:2380"; done
  members=""
  for name in $names; do
    port=$(free_port)
    docker run --detach --name "$name" --network "$network" --publish "127.0.0.1:$port:2379" quay.io/coreos/etcd:v3.6.15 \
      etcd --name "$name" \
        --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls "http://$name:2379" \
        --listen-peer-urls http://0.0.0.0:2380 --initial-advertise-peer-urls "http://$name:2380" \
        --initial-cluster "$initial" --initial-cluster-state new --initial-cluster-token "failover-$cluster-$run" >/dev/null
    containers="$containers $name"
    members="$members${members:+,}$name=127.0.0.1:$port"
  done
  spec="$spec${spec:+|}$cluster:$members"
done
for name in $containers; do
  until docker exec "$name" etcdctl endpoint health >/dev/null 2>&1; do sleep 0.5; done
done

TEST_ETCD_CLUSTERS="$spec" npx tsx --test "$@" test/failover/*.test.ts
