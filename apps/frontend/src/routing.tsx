import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

type RouteGateProps = {
  authenticated: boolean;
  checking: boolean;
  loading: ReactNode;
};

export function gamePath(gameCode: string): string {
  return `/games/${encodeURIComponent(gameCode)}`;
}

export function requestedPath(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("from" in state)) return null;
  const from = (state as { from?: unknown }).from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : null;
}

export function RequireSession({ authenticated, checking, loading, children }: RouteGateProps & { children: ReactNode }) {
  const location = useLocation();
  if (checking) return loading;
  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  }
  return children;
}

export function HomeRedirect({ authenticated, checking, activeGameCode, loading }: RouteGateProps & { activeGameCode: string | null }) {
  if (checking) return loading;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <Navigate to={activeGameCode ? gamePath(activeGameCode) : "/lobby"} replace />;
}

export function LoginGate({ authenticated, checking, activeGameCode, loading, children }: RouteGateProps & { activeGameCode: string | null; children: ReactNode }) {
  if (checking) return loading;
  if (authenticated) return <Navigate to={activeGameCode ? gamePath(activeGameCode) : "/lobby"} replace />;
  return children;
}

export function LobbyGate({ activeGameCode, checking, loading, children }: { activeGameCode: string | null; checking: boolean; loading: ReactNode; children: ReactNode }) {
  if (checking) return loading;
  if (activeGameCode) return <Navigate to={gamePath(activeGameCode)} replace />;
  return children;
}
