import { Amplify } from "aws-amplify";
import { confirmSignUp, fetchAuthSession, getCurrentUser, resendSignUpCode, signIn, signOut, signUp } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage as amplifySessionStorage } from "aws-amplify/utils";

const LOCAL_SESSION_KEY = "battleship.local-session";

export type UserSession = { username: string };
export type RegistrationResult = { confirmationRequired: boolean; destination?: string };

export interface AuthProvider {
  readonly requiresEmail: boolean;
  register(username: string, email: string, password: string): Promise<RegistrationResult>;
  confirmRegistration(username: string, code: string): Promise<void>;
  resendConfirmation(username: string): Promise<string | undefined>;
  login(username: string, password: string): Promise<UserSession>;
  restoreSession(): Promise<UserSession | null>;
  getAccessToken(): Promise<string>;
  refreshSession(): Promise<string | null>;
  logout(): Promise<void>;
}

export function authenticationErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const messages: Record<string, string> = {
    UsernameExistsException: "That username is already registered.",
    UserNotFoundException: "The username or password is incorrect.",
    NotAuthorizedException: "The username or password is incorrect.",
    UserNotConfirmedException: "Confirm your account before signing in.",
    CodeMismatchException: "The confirmation code is incorrect.",
    ExpiredCodeException: "That confirmation code expired. Request a new one.",
    InvalidPasswordException: "The password does not meet the security requirements.",
    LimitExceededException: "Too many attempts. Wait a moment and try again."
  };
  return messages[name] ?? "Authentication failed. Please try again.";
}

type LocalStoredSession = { accessToken: string; username: string; expiresAt: number };

async function localRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Authentication failed.");
  return payload as T;
}

function readLocalSession(): LocalStoredSession | null {
  try {
    const raw = sessionStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as LocalStoredSession;
    if (!session.accessToken || !session.username || session.expiresAt <= Date.now()) {
      sessionStorage.removeItem(LOCAL_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    sessionStorage.removeItem(LOCAL_SESSION_KEY);
    return null;
  }
}

class LocalAuthProvider implements AuthProvider {
  readonly requiresEmail = false;
  async register(username: string, _email: string, password: string) {
    await localRequest("/api/auth/register", { username, password });
    return { confirmationRequired: false };
  }
  async confirmRegistration() { throw new Error("Development accounts do not require confirmation."); }
  async resendConfirmation() { return undefined; }
  async login(username: string, password: string): Promise<UserSession> {
    const result = await localRequest<{ access_token: string; expires_in: number }>("/api/auth/login", { username, password });
    sessionStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({ accessToken: result.access_token, username, expiresAt: Date.now() + result.expires_in * 1000 } satisfies LocalStoredSession));
    return { username };
  }
  async restoreSession() { const session = readLocalSession(); return session ? { username: session.username } : null; }
  async getAccessToken() { const session = readLocalSession(); if (!session) throw new Error("No active session"); return session.accessToken; }
  async refreshSession() { return null; }
  async logout() { sessionStorage.removeItem(LOCAL_SESSION_KEY); }
}

type PublicConfig = { environment: "prod"; region: string; userPoolId: string; userPoolClientId: string };

class ProdAuthProvider implements AuthProvider {
  readonly requiresEmail = true;
  async register(username: string, email: string, password: string): Promise<RegistrationResult> {
    const result = await signUp({ username, password, options: { userAttributes: { email } } });
    return {
      confirmationRequired: result.nextStep.signUpStep === "CONFIRM_SIGN_UP",
      destination: result.nextStep.signUpStep === "CONFIRM_SIGN_UP" ? result.nextStep.codeDeliveryDetails?.destination : undefined
    };
  }
  async confirmRegistration(username: string, code: string) { await confirmSignUp({ username, confirmationCode: code }); }
  async resendConfirmation(username: string) { return (await resendSignUpCode({ username })).destination; }
  async login(username: string, password: string): Promise<UserSession> {
    const result = await signIn({ username, password });
    if (!result.isSignedIn) throw new Error("Sign-in requires an unsupported additional step.");
    return { username: (await getCurrentUser()).username };
  }
  async restoreSession() {
    try { return { username: (await getCurrentUser()).username }; } catch { return null; }
  }
  async getAccessToken() {
    const token = (await fetchAuthSession()).tokens?.accessToken;
    if (!token) throw new Error("No active session");
    return token.toString();
  }
  async refreshSession() {
    try { return (await fetchAuthSession({ forceRefresh: true })).tokens?.accessToken?.toString() ?? null; } catch { return null; }
  }
  async logout() { await signOut(); }
}

export async function createAuthProvider(): Promise<AuthProvider> {
  if (!import.meta.env.PROD) return new LocalAuthProvider();
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Production configuration could not be loaded.");
  const config = await response.json() as PublicConfig;
  if (config.environment !== "prod" || !config.region || !config.userPoolId || !config.userPoolClientId) {
    throw new Error("Production configuration is incomplete.");
  }
  Amplify.configure({ Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.userPoolClientId, loginWith: { username: true } } } });
  cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
  return new ProdAuthProvider();
}
