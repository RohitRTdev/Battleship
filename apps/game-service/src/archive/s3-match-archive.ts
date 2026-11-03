import {
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
  statisticsFromHistoryNames,
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
    if (!state.playerTwo) throw new Error("Archived match is missing its second player");
    for (const player of [state.playerOne, state.playerTwo]) {
      const detail = playerArchive(state, player.id);
      const prefix = `players/${playerPathPart(player.id)}`;
      await this.putJson(`${prefix}/matches/${state.gameId}.json`, detail);
      await this.putJson(`${prefix}/history/${historyFileName(detail)}`, matchSummary(detail));
    }
  }

  private async historyKeys(playerId: string): Promise<string[]> {
    const prefix = `players/${playerPathPart(playerId)}/history/`;
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
    const prefix = `players/${playerPathPart(playerId)}/history/`;
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
      statistics: statisticsFromHistoryNames(names),
      matches,
      nextCursor: start + pageKeys.length < keys.length && pageKeys.length > 0
        ? encodeCursor(names[start + pageKeys.length - 1])
        : null
    };
  }

  getPlayerMatch(playerId: string, matchId: string): Promise<ArchivedMatchDetail | null> {
    return this.getJson(`players/${playerPathPart(playerId)}/matches/${matchId}.json`);
  }
}
