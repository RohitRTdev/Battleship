/**
 * Manages the etcd data clusters registered on the control plane (ETCD_ENDPOINTS):
 *   list                      each cluster's state, endpoints, unfinished games and pending archive jobs
 *   register <id> <hosts>     add a cluster (hosts as host:port,host:port); new games start going to it
 *   drain <id>                stop sending new games to a cluster; its games carry on
 *   activate <id>             undo a drain
 *   remove <id>               retire a drained cluster once it has no unfinished games or archive jobs
 */
import { Etcd3, type Namespace } from "etcd3";
import { clusterUsage, readRegistry, type ClusterRecord } from "../store/etcd/clusters.js";
import { CONTROL_NAMESPACE, controlKeys, dataNamespace, encode } from "../store/etcd/keys.js";

const hostList = (list: string) => list.split(",").map((host) => host.trim()).filter(Boolean);

async function usageOf(record: ClusterRecord, id: string) {
  const client = new Etcd3({ hosts: record.endpoints, dialTimeout: 2_000 });
  try {
    return await clusterUsage(client.namespace(dataNamespace(id)));
  } finally {
    client.close();
  }
}

async function setState(control: Namespace, id: string, from: ClusterRecord["state"][], to: ClusterRecord["state"]): Promise<void> {
  const record = (await readRegistry(control)).get(id);
  if (!record) throw new Error(`no cluster ${id}`);
  if (!from.includes(record.state)) throw new Error(`cluster ${id} is ${record.state}; expected ${from.join(" or ")}`);
  await control.put(controlKeys.cluster(id)).value(encode({ ...record, state: to }));
  console.log(`${id}: ${record.state} -> ${to}`);
}

async function main(): Promise<void> {
  const [command, id, hosts] = process.argv.slice(2);
  const endpoints = hostList(process.env.ETCD_ENDPOINTS ?? "");
  if (endpoints.length === 0) throw new Error("ETCD_ENDPOINTS (the control-plane cluster) is required");
  const client = new Etcd3({ hosts: endpoints, dialTimeout: 2_000 });
  const control = client.namespace(CONTROL_NAMESPACE);
  try {
    switch (command) {
      case "list": {
        for (const [clusterId, record] of await readRegistry(control)) {
          const usage = record.state === "REMOVED" ? null : await usageOf(record, clusterId);
          console.log(`${clusterId}\t${record.state}\t${record.endpoints.join(",")}` +
            (usage ? `\tunfinished games: ${usage.unfinishedGames}\tpending archive jobs: ${usage.pendingArchiveJobs}` : ""));
        }
        return;
      }
      case "register": {
        if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || hostList(hosts ?? "").length === 0) throw new Error("usage: register <id> <host:port,...>");
        const existing = (await readRegistry(control)).get(id);
        if (existing && existing.state !== "REMOVED") throw new Error(`cluster ${id} is already registered (${existing.state})`);
        await control.put(controlKeys.cluster(id)).value(encode({ endpoints: hostList(hosts), state: "ACTIVE" } satisfies ClusterRecord));
        console.log(`${id}: registered as ACTIVE`);
        return;
      }
      case "drain":
        return await setState(control, id, ["ACTIVE"], "DRAINING");
      case "activate":
        return await setState(control, id, ["DRAINING"], "ACTIVE");
      case "remove": {
        const record = (await readRegistry(control)).get(id);
        if (!record) throw new Error(`no cluster ${id}`);
        if (record.state !== "DRAINING") throw new Error(`cluster ${id} is ${record.state}; drain it first`);
        const usage = await usageOf(record, id);
        if (usage.unfinishedGames > 0 || usage.pendingArchiveJobs > 0) {
          throw new Error(`cluster ${id} still has ${usage.unfinishedGames} unfinished games and ${usage.pendingArchiveJobs} pending archive jobs`);
        }
        return await setState(control, id, ["DRAINING"], "REMOVED");
      }
      default:
        throw new Error("usage: clusters list | register <id> <hosts> | drain <id> | activate <id> | remove <id>");
    }
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
