import path from "node:path";
import { LocalMatchArchive } from "./local-match-archive.js";
import type { MatchArchive } from "./match-archive.js";
import { S3MatchArchive } from "./s3-match-archive.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createMatchArchive(environment = process.env.APP_ENV): MatchArchive {
  if (environment === "prod") {
    return new S3MatchArchive(required("MATCH_ARCHIVE_BUCKET"), required("AWS_REGION"));
  }
  if (environment !== "dev") throw new Error("APP_ENV must be dev or prod");
  return new LocalMatchArchive(path.resolve(process.env.MATCH_ARCHIVE_PATH ?? "runtime/matches"));
}

export type { MatchArchive } from "./match-archive.js";
