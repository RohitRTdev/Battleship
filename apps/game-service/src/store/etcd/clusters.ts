import { Etcd3, type IKeyValue, type Namespace, type Watcher } from "etcd3";
import { controlKeys, dataKeys, dataNamespace, decode, encode } from "./keys.js";

/**
 * Data clusters are registered on the control plane as clusters/<id>. New games go only to ACTIVE clusters; a
 * DRAINING cluster keeps serving its games but gets no new ones; a REMOVED cluster is disconnected, and its games
 * and the claims on them are treated as gone.
 */
export type ClusterState = "ACTIVE" | "DRAINING" | "REMOVED";
export type ClusterRecord = { endpoints: string[]; state: ClusterState };

/** One connected data cluster: the id routes refer to, its state, and the namespace its per-game keys live in. */
export type DataCluster = { id: string; state: ClusterState; kv: Namespace };

function clusterId(kv: IKeyValue): string {
  const key = kv.key.toString();
  return key.slice(key.indexOf(controlKeys.clusterPrefix) + controlKeys.clusterPrefix.length);
}

export async function readRegistry(control: Namespace): Promise<Map<string, ClusterRecord>> {
  const { kvs } = await control.getAll().prefix(controlKeys.clusterPrefix).exec();
  return new Map(kvs.map((kv) => [clusterId(kv), decode<ClusterRecord>(kv.value)]));
}

/** Registers clusters that are not registered yet; existing records (including REMOVED ones) are left alone. */
export async function registerIfAbsent(control: Namespace, clusters: Array<[string, string[]]>): Promise<void> {
  for (const [id, endpoints] of clusters) {
    const record: ClusterRecord = { endpoints, state: "ACTIVE" };
    await control.if(controlKeys.cluster(id), "Create", "==", 0).then(control.put(controlKeys.cluster(id)).value(encode(record))).commit();
  }
}

/** Games not yet finished and archive jobs not yet done on one data cluster: it can only be removed when both are 0. */
export async function clusterUsage(kv: Namespace): Promise<{ unfinishedGames: number; pendingArchiveJobs: number }> {
  const games = await kv.getAll().prefix(dataKeys.gamePrefix).strings();
  const unfinishedGames = Object.values(games).filter((game) => decode<{ status: string }>(game).status !== "FINISHED").length;
  const pendingArchiveJobs = (await kv.getAll().prefix(dataKeys.archivePrefix).keys()).length;
  return { unfinishedGames, pendingArchiveJobs };
}

/**
 * The data clusters this node is connected to, kept in step with the registry: a registered cluster is connected,
 * a state change takes effect at once, and a REMOVED cluster is disconnected.
 */
export class ClusterSet {
  private readonly members = new Map<string, DataCluster & { client: Etcd3 }>();
  private readonly addedListeners: Array<(cluster: DataCluster) => void> = [];
  private readonly removedListeners: Array<(cluster: DataCluster) => void> = [];
  private watcher: Watcher | null = null;

  constructor(private readonly connect: (endpoints: string[]) => Etcd3) {}

  /** Every connected cluster, ACTIVE or DRAINING. */
  list(): DataCluster[] {
    return [...this.members.values()];
  }

  active(): DataCluster[] {
    return this.list().filter((cluster) => cluster.state === "ACTIVE");
  }

  get(id: string): DataCluster | undefined {
    return this.members.get(id);
  }

  onAdded(listener: (cluster: DataCluster) => void): void {
    this.addedListeners.push(listener);
  }

  onRemoved(listener: (cluster: DataCluster) => void): void {
    this.removedListeners.push(listener);
  }

  apply(id: string, record: ClusterRecord): void {
    const current = this.members.get(id);
    if (record.state === "REMOVED") {
      if (!current) return;
      this.members.delete(id);
      for (const listener of this.removedListeners) listener(current);
      current.client.close();
      return;
    }
    if (current) {
      current.state = record.state;
      return;
    }
    const client = this.connect(record.endpoints);
    const cluster = { id, state: record.state, kv: client.namespace(dataNamespace(id)), client };
    this.members.set(id, cluster);
    for (const listener of this.addedListeners) listener(cluster);
  }

  /** Loads the registry and follows it. Deleting a record changes nothing: retire a cluster by marking it REMOVED. */
  async follow(control: Namespace): Promise<void> {
    for (const [id, record] of await readRegistry(control)) this.apply(id, record);
    this.watcher = await control.watch().prefix(controlKeys.clusterPrefix).create();
    this.watcher.on("put", (kv) => this.apply(clusterId(kv), decode<ClusterRecord>(kv.value)));
    // After a dropped watch, changes may have been missed; reload the registry.
    this.watcher.on("disconnected", () => this.watcher?.once("connected", () => {
      void readRegistry(control).then((registry) => { for (const [id, record] of registry) this.apply(id, record); }, () => undefined);
    }));
  }

  async close(): Promise<void> {
    await this.watcher?.cancel().catch(() => undefined);
    for (const cluster of this.members.values()) cluster.client.close();
    this.members.clear();
  }
}
