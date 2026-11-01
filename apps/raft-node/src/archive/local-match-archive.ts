import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    try {
      await readFile(file);
    } catch {
      throw error;
    }
  }
}

export class LocalMatchArchive implements MatchArchive {
  constructor(private readonly root: string) {}

  async archiveMatch(state: GameState): Promise<void> {
    if (!state.playerTwo) throw new Error("Archived match is missing its second player");
    for (const player of [state.playerOne, state.playerTwo]) {
      const detail = playerArchive(state, player.id);
      const playerRoot = path.join(this.root, "players", playerPathPart(player.id));
      await writeJsonAtomically(path.join(playerRoot, "matches", `${state.gameId}.json`), detail);
      await writeJsonAtomically(path.join(playerRoot, "history", historyFileName(detail)), matchSummary(detail));
    }
  }

  async listPlayerMatches(playerId: string, cursor: string | null, limit: number): Promise<ArchivePage> {
    const directory = path.join(this.root, "players", playerPathPart(playerId), "history");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { statistics: statisticsFromHistoryNames([]), matches: [], nextCursor: null };
      }
      throw error;
    }
    const after = decodeCursor(cursor);
    if (cursor && !after) throw new Error("INVALID_CURSOR");
    const start = after ? names.findIndex((name) => name === after) + 1 : 0;
    if (after && start === 0) throw new Error("INVALID_CURSOR");
    const pageNames = names.slice(start, start + limit);
    const matches = await Promise.all(pageNames.map((name) => readJson<PlayerMatchSummary>(path.join(directory, name))));
    return {
      statistics: statisticsFromHistoryNames(names),
      matches,
      nextCursor: start + pageNames.length < names.length && pageNames.length > 0
        ? encodeCursor(pageNames.at(-1)!)
        : null
    };
  }

  async getPlayerMatch(playerId: string, matchId: string): Promise<ArchivedMatchDetail | null> {
    try {
      return await readJson<ArchivedMatchDetail>(path.join(
        this.root,
        "players",
        playerPathPart(playerId),
        "matches",
        `${matchId}.json`
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
