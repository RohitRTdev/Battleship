import { randomBytes } from "node:crypto";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A random 8-character code players use to share and join a game. */
export function generateGameCode(): string {
  return [...randomBytes(8)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}
