import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";

export type AuthenticatedUser = { id: string; username: string };

export interface TokenVerifier {
  verify(token: string): Promise<AuthenticatedUser>;
}

export type ProductionAuthConfig = { userPoolId: string; clientId: string };

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

function requireValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createToken(user: AuthenticatedUser, secret = process.env.JWT_SECRET): string {
  return jwt.sign({ name: user.username }, requireValue("JWT_SECRET", secret), {
    algorithm: "HS256",
    subject: user.id,
    issuer: "battleship-auth",
    audience: "battleship-api",
    expiresIn: "1h"
  });
}

export function createLocalTokenVerifier(secret: string): TokenVerifier {
  return {
    async verify(token) {
      const payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        issuer: "battleship-auth",
        audience: "battleship-api"
      });
      if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.name !== "string") {
        throw new Error("Token does not contain a valid user");
      }
      return { id: payload.sub, username: payload.name };
    }
  };
}

export async function createProductionTokenVerifier(config: ProductionAuthConfig): Promise<TokenVerifier> {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    tokenUse: "access"
  });
  await verifier.hydrate();
  return {
    async verify(token) {
      const payload = await verifier.verify(token);
      if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
        throw new Error("Token does not contain a valid user");
      }
      return { id: payload.sub, username: payload.username };
    }
  };
}

export async function createTokenVerifierFromEnvironment(environment = process.env.APP_ENV): Promise<TokenVerifier> {
  if (environment === "prod") {
    return createProductionTokenVerifier({
      userPoolId: requireValue("COGNITO_USER_POOL_ID", process.env.COGNITO_USER_POOL_ID),
      clientId: requireValue("COGNITO_APP_CLIENT_ID", process.env.COGNITO_APP_CLIENT_ID)
    });
  }
  if (environment !== "dev") throw new Error("APP_ENV must be dev or prod");
  return createLocalTokenVerifier(requireValue("JWT_SECRET", process.env.JWT_SECRET));
}

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match) throw new Error("Bearer token is required");
  return match[1];
}

export function authorizeUser(verifier: TokenVerifier): RequestHandler {
  return (request, response, next) => {
    let token: string;
    try {
      token = bearerToken(request.get("authorization"));
    } catch {
      response.status(401).json({ error: "Invalid or expired access token" });
      return;
    }
    void verifier.verify(token).then((user) => {
      request.user = user;
      next();
    }).catch(() => {
      response.status(401).json({ error: "Invalid or expired access token" });
    });
  };
}
