import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { ArchivedMatchDetail, PlayerMatchSummary } from "@battleship/game-contract";
import type { GameState } from "../game/index.js";
import {
  decodeCursor,
  encodeCursor,
  historyFileName,
  matchSummary,
  playerArchive,
  playerPathPart,
  type ArchivePage,
  type MatchArchive
} from "./match-archive.js";

export class S3MatchArchive implements MatchArchive {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, region: string) {
    this.client = new S3Client({ region });
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: `${JSON.stringify(value)}\n`,
      ContentType: "application/json",
      ServerSideEncryption: "AES256"
    }));
  }

  async archiveMatch(state: GameState): Promise<void> {
    if (!state.playerTwo || !state.endedAt) throw new Error("Archived match is missing its players or completion time");
    const ended = Date.parse(state.endedAt);
    if (!Number.isFinite(ended)) throw new Error("Invalid match completion time");
    for (const player of [state.playerOne, state.playerTwo]) {
      const detail = playerArchive(state, player.id);
      const playerKey = playerPathPart(player.id);
      // Recheck before every upload so retries do not recreate expired archives.
      if (Date.now() - ended < 7 * 86_400_000) {
        await this.putJson(`details/${playerKey}/${state.gameId}/${ended}.json`, detail);
      }
      if (Date.now() - ended < 30 * 86_400_000) {
        await this.putJson(`history/${playerKey}/${historyFileName(detail)}`, matchSummary(detail));
      }
    }
  }

  async deleteExpired(now: number): Promise<void> {
    for (const [prefix, days] of [["details/", 7], ["history/", 30]] as const) {
      let continuationToken: string | undefined;
      do {
        const page = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken
        }));
        const expired = (page.Contents ?? []).flatMap(({ Key }) => {
          if (!Key) return [];
          const name = Key.slice(Key.lastIndexOf("/") + 1);
          const match = prefix === "details/" ? /^(\d{13})\.json$/.exec(name) : /^(\d{13})_/.exec(name);
          if (!match) return [];
          const ended = prefix === "details/" ? Number(match[1]) : 9_999_999_999_999 - Number(match[1]);
          return ended <= now - days * 86_400_000 ? [{ Key }] : [];
        });
        if (expired.length) {
          const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: expired } }));
          if (result.Errors?.length) throw new Error(`S3 archive deletion failed for ${result.Errors.length} objects`);
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
    }
  }

  private async historyKeys(playerId: string): Promise<string[]> {
    const prefix = `history/${playerPathPart(playerId)}/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }));
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
  }

  private async getJson<T>(key: string): Promise<T | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) return null;
      return JSON.parse(await response.Body.transformToString()) as T;
    } catch (error) {
      const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async listPlayerMatches(playerId: string, cursor: string | null, limit: number): Promise<ArchivePage> {
    const prefix = `history/${playerPathPart(playerId)}/`;
    const keys = await this.historyKeys(playerId);
    const names = keys.map((key) => key.slice(prefix.length));
    const after = decodeCursor(cursor);
    if (cursor && !after) throw new Error("INVALID_CURSOR");
    const start = after ? names.findIndex((name) => name === after) + 1 : 0;
    if (after && start === 0) throw new Error("INVALID_CURSOR");
    const pageKeys = keys.slice(start, start + limit);
    const summaries = await Promise.all(pageKeys.map((key) => this.getJson<PlayerMatchSummary>(key)));
    const matches = summaries.filter((summary): summary is PlayerMatchSummary => summary !== null);
    return {
      matches,
      nextCursor: start + pageKeys.length < keys.length && pageKeys.length > 0
        ? encodeCursor(names[start + pageKeys.length - 1])
        : null
    };
  }

  async getPlayerMatch(playerId: string, matchId: string): Promise<ArchivedMatchDetail | null> {
    const prefix = `details/${playerPathPart(playerId)}/${matchId}/`;
    const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 }));
    const key = page.Contents?.[0]?.Key;
    return key ? this.getJson<ArchivedMatchDetail>(key) : null;
  }
}
