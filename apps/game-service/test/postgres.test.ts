import pg from "pg";
import { createPostgresBackend } from "../src/store/postgres/backend.js";
import { defineStoreContract } from "./store-contract.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run the tests with `npm test`");

const admin = new pg.Pool({ connectionString: url });

defineStoreContract("postgres", {
  async open() {
    process.env.DATABASE_URL = url;
    const backend = createPostgresBackend({ timeoutEnabled: false });
    await backend.start();
    return backend;
  },
  async reset() {
    await admin.query(
      "TRUNCATE games, game_events, active_player_games, game_presence, matchmaking_queue, match_archive_jobs CASCADE"
    );
  },
  async dispose() {
    await admin.end();
  }
});
