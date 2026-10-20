import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  return secret;
}

const jwtSecret = requireJwtSecret();

export type AuthenticatedUser = {
  id: string;
  username: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function createToken(user: AuthenticatedUser): string {
  return jwt.sign(
    { name: user.username },
    jwtSecret,
    {
      algorithm: "HS256",
      subject: user.id,
      issuer: "battleship-auth",
      audience: "battleship-api",
      expiresIn: "1h"
    }
  );
}

function getAuthenticatedUser(
  authorization: string | undefined
): AuthenticatedUser {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Bearer token is required");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new Error("Bearer token is required");
  }

  const payload = jwt.verify(token, jwtSecret, {
    algorithms: ["HS256"],
    issuer: "battleship-auth",
    audience: "battleship-api"
  });

  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.name !== "string"
  ) {
    throw new Error("Token does not contain a valid user");
  }

  return {
    id: payload.sub,
    username: payload.name
  };
}

export const authorizeUser: RequestHandler = (request, response, next) => {
  try {
    request.user = getAuthenticatedUser(request.get("authorization"));
    next();
  } catch {
    response.status(401).json({ error: "Invalid or expired access token" });
  }
};
