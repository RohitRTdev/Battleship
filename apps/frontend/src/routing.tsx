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

export const matchmakingPath = "/matchmaking";

function activityPath(activeGameCode: string | null, searching: boolean): string {
  return activeGameCode ? gamePath(activeGameCode) : searching ? matchmakingPath : "/lobby";
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

export function HomeRedirect({ authenticated, checking, activeGameCode, searching, loading }: RouteGateProps & { activeGameCode: string | null; searching: boolean }) {
  if (checking) return loading;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <Navigate to={activityPath(activeGameCode, searching)} replace />;
}

export function LoginGate({ authenticated, checking, activeGameCode, searching, loading, children }: RouteGateProps & { activeGameCode: string | null; searching: boolean; children: ReactNode }) {
  if (checking) return loading;
  if (authenticated) return <Navigate to={activityPath(activeGameCode, searching)} replace />;
  return children;
}

export function LobbyGate({ activeGameCode, searching, checking, loading, children }: { activeGameCode: string | null; searching: boolean; checking: boolean; loading: ReactNode; children: ReactNode }) {
  if (checking) return loading;
  if (activeGameCode) return <Navigate to={gamePath(activeGameCode)} replace />;
  if (searching) return <Navigate to={matchmakingPath} replace />;
  return children;
}

export function MatchmakingGate({ activeGameCode, searching, checking, loading, children }: { activeGameCode: string | null; searching: boolean; checking: boolean; loading: ReactNode; children: ReactNode }) {
  if (checking) return loading;
  if (activeGameCode) return <Navigate to={gamePath(activeGameCode)} replace />;
  if (!searching) return <Navigate to="/lobby" replace />;
  return children;
}

export function GameGate({ activeGameCode, searching, checking, loading, routedGameCode, children }: { activeGameCode: string | null; searching: boolean; checking: boolean; loading: ReactNode; routedGameCode: string | null; children: ReactNode }) {
  if (checking) return loading;
  if (searching) return <Navigate to={matchmakingPath} replace />;
  if (activeGameCode && activeGameCode !== routedGameCode) return <Navigate to={gamePath(activeGameCode)} replace />;
  return children;
}
