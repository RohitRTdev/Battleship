import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import type { AttackView, ConnectionStatus, Coordinate, PlayerGameView, PlayerSummary } from "@battleship/game-contract";
import { ApiFailure, SessionExpiredError, createApi } from "./api";
import { authenticationErrorMessage, createAuthProvider, type AuthProvider, type UserSession } from "./auth";
import { BOARD_SIZE, FLEET, autoPlaceFleet, cellsFor, toPlacements, validatePlacement } from "./fleet";
import type { Orientation, PlacedShip } from "./fleet";
import "./styles.css";

const COLUMN_LABELS = "ABCDEFGHIJ".split("");
const CONNECTION_TIMEOUT_MS = 6_000;

type Session = UserSession;
type NetworkState = "connected" | "reconnecting" | "offline";

let auth: AuthProvider;
let api: ReturnType<typeof createApi>;

function coordinateKey({ row, column }: Coordinate): string { return `${row}:${column}`; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "brand--compact" : ""}`}>Battleship</div>;
}

function ButtonSpinner() { return <span className="button-spinner" aria-hidden="true" />; }

function AuthScreen({ initialNotice, onAuthenticated }: { initialNotice: string; onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "confirm">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialNotice);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanUsername = username.trim().toLowerCase();
    if (!cleanUsername || (mode !== "confirm" && !password)) { setError("Enter your username and password."); return; }
    if (mode === "register" && auth.requiresEmail && !email.trim()) { setError("Enter your email address."); return; }
    if (mode === "confirm" && !confirmationCode.trim()) { setError("Enter the confirmation code."); return; }
    setPending(true); setError("");
    try {
      if (mode === "confirm") {
        await auth.confirmRegistration(cleanUsername, confirmationCode.trim());
        setMode("login"); setError("Account confirmed. Sign in to continue.");
        return;
      }
      if (mode === "register") {
        const registration = await auth.register(cleanUsername, email.trim(), password);
        if (registration.confirmationRequired) {
          setMode("confirm");
          setError(registration.destination ? `Enter the code sent to ${registration.destination}.` : "Enter the confirmation code sent to your email.");
          return;
        }
      }
      onAuthenticated(await auth.login(cleanUsername, password));
    } catch (caught) { setError(auth.requiresEmail ? authenticationErrorMessage(caught) : caught instanceof Error ? caught.message : "Authentication failed."); }
    finally { setPending(false); }
  }

  return <main className="auth-shell"><section className="auth-panel"><div className="auth-card">
      <div className="auth-mobile-brand"><Brand compact /></div><h2>{mode === "login" ? "Login" : mode === "register" ? "Register" : "Confirm account"}</h2><p className="muted">{mode === "login" ? "Sign in to continue." : mode === "register" ? "Create an account to start playing." : "Enter the code sent to your email."}</p>
      {mode !== "confirm" && <div className="segmented" role="tablist" aria-label="Authentication mode"><button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }} role="tab" aria-selected={mode === "login"}>Sign in</button><button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); }} role="tab" aria-selected={mode === "register"}>Register</button></div>}
      <form onSubmit={submit} className="auth-form">
        <label>Username<span className="input-wrap"><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" maxLength={32} /></span></label>
        {mode === "register" && auth.requiresEmail && <label>Email<span className="input-wrap"><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" /></span></label>}
        {mode !== "confirm" && <label>Password<span className="input-wrap"><input type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" /><button type="button" className="reveal" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></span></label>}
        {mode === "confirm" && <label>Confirmation code<span className="input-wrap"><input inputMode="numeric" autoComplete="one-time-code" value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value)} placeholder="Confirmation code" /></span></label>}
        {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
        <button className="button button--primary button--wide" disabled={pending}>{pending && <ButtonSpinner />}{mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Confirm account"}</button>
        {mode === "confirm" && <button type="button" className="text-button" onClick={() => void auth.resendConfirmation(username.trim().toLowerCase()).then(() => setError("A new confirmation code was sent.")).catch((caught) => setError(authenticationErrorMessage(caught)))}>Resend code</button>}
      </form>
    </div></section>
  </main>;
}

function AppHeader({ username, network, onLogout }: { username: string; network: NetworkState; onLogout: () => void }) {
  return <header className="app-header"><Brand compact /><div className="header-actions"><span className={`network-pill network-pill--${network}`}><i />{network === "connected" ? "Connected" : network === "offline" ? "Offline" : "Reconnecting"}</span><span className="user-chip"><span>{username.slice(0, 1).toUpperCase()}</span>{username}</span><button className="icon-button" onClick={onLogout} aria-label="Sign out" title="Sign out">↪</button></div></header>;
}

function Lobby({ username, network, busy, error, onCreate, onJoin }: { username: string; network: NetworkState; busy: string; error: string; onCreate: () => void; onJoin: (code: string) => void }) {
  const [code, setCode] = useState("");
  return <main className="lobby page-enter">
    <section className="lobby-intro"><p className="eyebrow">PLAY</p><h1>Welcome, <em>{username}</em></h1><p>Create a new game or join one with a code.</p></section>
    {error && <div className="banner banner--error" role="alert"><span>!</span>{error}</div>}
    <section className="lobby-grid">
      <article className="mission-card mission-card--create"><p className="eyebrow">NEW GAME</p><h2>Create a game</h2><p>Get a private code to share with another player.</p><ul><li>Private 8-character code</li><li>Creator plays first</li></ul><button className="button button--primary" onClick={onCreate} disabled={Boolean(busy)}>{busy === "create" && <ButtonSpinner />}Create game</button></article>
      <article className="mission-card"><p className="eyebrow">JOIN GAME</p><h2>Enter a code</h2><p>Use the code shared by the player who created the game.</p><label className="code-label">GAME CODE<input className="code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, 8))} placeholder="ABCD1234" maxLength={8} autoCapitalize="characters" /></label><button className="button button--secondary" onClick={() => onJoin(code)} disabled={Boolean(busy) || code.length !== 8}>{busy === "join" && <ButtonSpinner />}Join game</button></article>
    </section>
  </main>;
}

function Presence({ status }: { status: ConnectionStatus }) {
  const label = status === "CONNECTED" ? "Connected" : status === "LAGGING" ? "Connection slow" : status === "NOT_JOINED" ? "Not joined" : "Connecting";
  return <span className={`presence presence--${status.toLowerCase()}`}><i />{label}</span>;
}

function PlayerCard({ player, isYou, active }: { player?: PlayerSummary; isYou?: boolean; active?: boolean }) {
  return <div className={`player-card ${active ? "player-card--active" : ""} ${!player ? "player-card--empty" : ""}`}><div className="avatar">{player ? player.username.slice(0, 1).toUpperCase() : "?"}</div><div><strong>{player?.username ?? "Waiting for player"}{isYou && <small> YOU</small>}</strong>{player ? <Presence status={player.connectionStatus} /> : <span className="muted small">Share the game code</span>}</div>{active && <span className="turn-tag">TURN</span>}</div>;
}

function GameCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() { await navigator.clipboard.writeText(code).catch(() => undefined); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
  return <button className="game-code" onClick={copy} aria-label={`Copy game code ${code}`}><span>{code}</span><small>{copied ? "COPIED" : "COPY CODE"}</small></button>;
}

function WaitingRoom({ game, busy, error, onCancel }: { game: PlayerGameView; busy: boolean; error: string; onCancel: () => void }) {
  const you = game.players.find((player) => player.id === game.yourPlayerId);
  return <main className="game-shell page-enter"><section className="waiting-card"><div className="waiting-status" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">GAME CREATED</p><h1>Waiting for another player</h1><p className="muted">Share this game code with them.</p><GameCode code={game.gameCode} /><div className="waiting-players"><PlayerCard player={you} isYou /><span className="versus">VS</span><PlayerCard /></div>{error && <div className="banner banner--error" role="alert">{error}</div>}<button className="button button--ghost danger" onClick={onCancel} disabled={busy}>{busy && <ButtonSpinner />}Cancel game</button></section></main>;
}

function PlacementBoard({ placed, selectedId, orientation, onPlace, onHover }: { placed: PlacedShip[]; selectedId: string; orientation: Orientation; onPlace: (shipId: string, row: number, column: number) => void; onHover: (candidate: PlacedShip | null) => void }) {
  const [preview, setPreview] = useState<PlacedShip | null>(null);
  const previewError = preview ? validatePlacement(preview, placed) : null;
  const previewCells = new Set(preview ? cellsFor(preview).filter(({ row, column }) => row >= 0 && row < BOARD_SIZE && column >= 0 && column < BOARD_SIZE).map(coordinateKey) : []);
  const occupied = new Map<string, string>();
  placed.forEach((ship) => cellsFor(ship).forEach((cell) => occupied.set(coordinateKey(cell), ship.id)));
  function updatePreview(row: number, column: number, shipId = selectedId) { const base = FLEET.find((ship) => ship.id === shipId)!; const existing = placed.find((ship) => ship.id === shipId); const candidate: PlacedShip = { ...base, row, column, orientation: existing?.orientation ?? orientation }; setPreview(candidate); onHover(candidate); }
  return <div className="board-wrap placement-board-wrap" onMouseLeave={() => { setPreview(null); onHover(null); }}><div className="board-corner" />{COLUMN_LABELS.map((label) => <span className="axis axis--column" key={label}>{label}</span>)}{Array.from({ length: BOARD_SIZE }, (_, row) => <span className="axis axis--row" key={row}>{row + 1}</span>)}<div className="board placement-board" role="grid" aria-label="Fleet placement board">
    {Array.from({ length: 100 }, (_, index) => { const row = Math.floor(index / 10); const column = index % 10; const key = `${row}:${column}`; const shipId = occupied.get(key); const isPreview = previewCells.has(key); return <button type="button" role="gridcell" aria-label={`${COLUMN_LABELS[column]}${row + 1}${shipId ? ", occupied" : ""}`} key={key} className={`cell ${shipId ? "cell--ship" : ""} ${shipId === selectedId ? "cell--selected" : ""} ${isPreview ? previewError ? "cell--invalid" : "cell--preview" : ""}`} onMouseEnter={() => updatePreview(row, column)} onFocus={() => updatePreview(row, column)} onClick={() => onPlace(selectedId, row, column)} onDragOver={(event) => { event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); onPlace(event.dataTransfer.getData("text/plain") || selectedId, row, column); }}><span /></button>; })}
  </div></div>;
}

function FleetPlacement({ game, busy, error, onSubmit, onCancel }: { game: PlayerGameView; busy: boolean; error: string; onSubmit: (ships: PlacedShip[]) => void; onCancel: () => void }) {
  const [placed, setPlaced] = useState<PlacedShip[]>([]);
  const [selectedId, setSelectedId] = useState(FLEET[0].id);
  const [orientations, setOrientations] = useState<Record<string, Orientation>>(() => Object.fromEntries(FLEET.map((ship) => [ship.id, "horizontal"])));
  const [placementError, setPlacementError] = useState("");
  const [hoverMessage, setHoverMessage] = useState("");
  const you = game.players.find((player) => player.id === game.yourPlayerId)!;
  const opponent = game.players.find((player) => player.id !== game.yourPlayerId);
  function place(shipId: string, row: number, column: number) { const base = FLEET.find((ship) => ship.id === shipId); if (!base) return; const existing = placed.find((ship) => ship.id === shipId); const candidate: PlacedShip = { ...base, row, column, orientation: existing?.orientation ?? orientations[shipId] }; const issue = validatePlacement(candidate, placed); if (issue) { setPlacementError(issue); return; } setPlaced((current) => [...current.filter((ship) => ship.id !== shipId), candidate]); setPlacementError(""); const next = FLEET.find((ship) => ship.id !== shipId && !placed.some((item) => item.id === ship.id)); if (next) setSelectedId(next.id); }
  function rotate(shipId = selectedId) { const current = placed.find((ship) => ship.id === shipId); const nextOrientation: Orientation = (current?.orientation ?? orientations[shipId]) === "horizontal" ? "vertical" : "horizontal"; if (current) { const candidate = { ...current, orientation: nextOrientation }; const issue = validatePlacement(candidate, placed); if (issue) { setPlacementError(`${issue} Move the ship before rotating.`); return; } setPlaced((ships) => ships.map((ship) => ship.id === shipId ? candidate : ship)); } setOrientations((values) => ({ ...values, [shipId]: nextOrientation })); setSelectedId(shipId); setPlacementError(""); }
  if (you.fleetSubmitted) return <main className="game-shell page-enter"><section className="waiting-card compact-wait"><div className="waiting-status" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">SHIPS PLACED</p><h1>Waiting for {opponent?.username ?? "the other player"}</h1><p className="muted">Your placement is locked. The game starts when both players are ready.</p><div className="waiting-players"><PlayerCard player={you} isYou /><span className="versus">VS</span><PlayerCard player={opponent} /></div><button className="button button--ghost danger" onClick={onCancel} disabled={busy}>Cancel game</button></section></main>;
  return <main className="placement page-enter"><div className="section-heading"><div><p className="eyebrow">GAME {game.gameCode}</p><h1>Place your ships</h1><p>Ships cannot overlap or touch, including diagonally.</p></div><span className="step-pill">{placed.length} / {FLEET.length} PLACED</span></div><div className="placement-layout">
    <section className="board-panel"><div className="board-panel__heading"><span>YOUR BOARD</span><small>Select a ship, then choose its starting square</small></div><PlacementBoard placed={placed} selectedId={selectedId} orientation={placed.find((ship) => ship.id === selectedId)?.orientation ?? orientations[selectedId]} onPlace={place} onHover={(candidate) => setHoverMessage(candidate ? validatePlacement(candidate, placed) ?? "This position works." : "")} /><p className={`placement-hint ${placementError || hoverMessage.includes("cannot") || hoverMessage.includes("outside") ? "placement-hint--error" : ""}`} aria-live="polite">{placementError || hoverMessage || "Select a placed ship to move it."}</p></section>
    <aside className="fleet-panel"><div className="fleet-panel__heading"><p className="eyebrow">SHIPS</p><h2>Your ships</h2></div><div className="ship-list">{FLEET.map((ship) => { const position = placed.find((item) => item.id === ship.id); const selected = selectedId === ship.id; return <button key={ship.id} draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", ship.id); setSelectedId(ship.id); }} onClick={() => setSelectedId(ship.id)} onDoubleClick={() => rotate(ship.id)} className={`ship-card ${selected ? "ship-card--selected" : ""} ${position ? "ship-card--placed" : ""}`}><span className="ship-silhouette" aria-hidden="true">{Array.from({ length: ship.length }, (_, index) => <i key={index} />)}</span><span><strong>{ship.name}</strong><small>{ship.length} SQUARES · {position ? "PLACED" : "NOT PLACED"}</small></span><b>{position ? "✓" : "⋮⋮"}</b></button>; })}</div><div className="placement-actions"><button className="button button--secondary" onClick={() => rotate()}>↻ Rotate ship</button><div className="button-row"><button className="button button--ghost" onClick={() => { setPlaced(autoPlaceFleet()); setPlacementError(""); }}>Place automatically</button><button className="button button--ghost" onClick={() => { setPlaced([]); setPlacementError(""); }}>Reset</button></div></div>{(error || placementError) && <div className="banner banner--error" role="alert">{error || placementError}</div>}<button className="button button--primary button--wide" disabled={placed.length !== FLEET.length || busy} onClick={() => onSubmit(placed)}>{busy && <ButtonSpinner />}Save placement</button><button className="text-button danger" onClick={onCancel} disabled={busy}>Cancel game</button></aside>
  </div></main>;
}

function BattleBoard({ label, own, game, disabled, pendingShot, onFire }: { label: string; own: boolean; game: PlayerGameView; disabled?: boolean; pendingShot?: Coordinate | null; onFire?: (row: number, column: number) => void }) {
  const attacks: AttackView[] = own ? game.opponentAttacks : game.yourAttacks;
  const attackMap = new Map(attacks.map((attack) => [coordinateKey(attack.coordinate), attack]));
  const shipCells = new Map<string, { hit: boolean; sunk: boolean }>();
  if (own) game.yourFleet?.forEach((ship) => ship.cells.forEach((cell) => shipCells.set(coordinateKey(cell), { hit: ship.hits.some((hit) => coordinateKey(hit) === coordinateKey(cell)), sunk: ship.sunk })));
  return <div className="battle-board-block"><div className="battle-board-title"><span>{label}</span><small>{own ? "DEFENSE GRID" : "TARGETING GRID"}</small></div><div className="board-wrap"><div className="board-corner" />{COLUMN_LABELS.map((column) => <span className="axis axis--column" key={column}>{column}</span>)}{Array.from({ length: 10 }, (_, row) => <span className="axis axis--row" key={row}>{row + 1}</span>)}<div className={`board battle-board ${own ? "battle-board--own" : "battle-board--target"}`} role="grid" aria-label={label}>
    {Array.from({ length: 100 }, (_, index) => { const row = Math.floor(index / 10); const column = index % 10; const key = `${row}:${column}`; const attack = attackMap.get(key); const ship = shipCells.get(key); const pending = pendingShot?.row === row && pendingShot.column === column; const hit = attack && attack.result !== "MISS"; return <button key={key} role="gridcell" disabled={own || disabled || Boolean(attack)} aria-label={`${COLUMN_LABELS[column]}${row + 1}${attack ? `, ${attack.result.toLowerCase()}` : ship ? ", ship" : ""}`} onClick={() => onFire?.(row, column)} className={`cell ${ship ? "cell--own-ship" : ""} ${ship?.sunk ? "cell--sunk-ship" : ""} ${attack?.result === "MISS" ? "cell--miss" : ""} ${hit ? "cell--hit" : ""} ${pending ? "cell--pending-shot" : ""}`}>{attack?.result === "MISS" && <span className="miss-dot" />}{hit && <span className="hit-mark">×</span>}{pending && <span className="target-lock" />}</button>; })}
  </div></div></div>;
}

function FleetCounter({ title, sunk }: { title: string; sunk: number }) { return <div className="fleet-counter"><div><span>{title}</span><strong>{sunk}<small>/5 SUNK</small></strong></div><div className="mini-fleet" aria-hidden="true">{FLEET.map((ship, index) => <span key={ship.id} className={index < sunk ? "sunk" : ""} style={{ width: `${ship.length * 5 + 8}px` }} />)}</div></div>; }

function Battle({ game, network, busy, error, pendingShot, onFire, onSurrender, onLobby }: { game: PlayerGameView; network: NetworkState; busy: boolean; error: string; pendingShot: Coordinate | null; onFire: (row: number, column: number) => void; onSurrender: () => void; onLobby: () => void }) {
  const you = game.players.find((player) => player.id === game.yourPlayerId)!;
  const opponent = game.players.find((player) => player.id !== game.yourPlayerId);
  const ownSunk = game.yourFleet?.filter((ship) => ship.sunk).length ?? 0;
  const enemySunk = game.yourAttacks.filter((attack) => attack.result === "SUNK" || attack.result === "WIN").length;
  const finished = game.status === "FINISHED"; const won = game.winnerPlayerId === game.yourPlayerId; const cancelled = game.completionReason === "CANCELLED";
  return <main className={`battle page-enter ${finished ? "battle--finished" : ""}`}><section className={`turn-banner ${game.isYourTurn ? "turn-banner--yours" : ""} ${finished ? won ? "turn-banner--win" : "turn-banner--loss" : ""}`} aria-live="polite"><div><p className="eyebrow">{finished ? "GAME OVER" : "CURRENT TURN"}</p><h1>{finished ? cancelled ? "Game cancelled" : won ? "You won" : "You lost" : game.isYourTurn ? "Your turn" : `${opponent?.username ?? "Opponent"}'s turn`}</h1><p>{finished ? game.completionReason === "SURRENDER" ? (won ? "The other player surrendered." : "You surrendered.") : cancelled ? "The game ended without a winner." : won ? "You sank every enemy ship." : "Your fleet was sunk." : game.isYourTurn ? "Choose a square on the enemy board." : "Waiting for the other player."}</p></div><GameCode code={game.gameCode} /></section>
    <section className="combatants"><PlayerCard player={you} isYou active={!finished && game.currentTurn === you.id} /><div className="combat-line"><i /><span>VS</span><i /></div><PlayerCard player={opponent} active={!finished && game.currentTurn === opponent?.id} /></section>
    {opponent?.connectionStatus === "LAGGING" && !finished && <div className="banner banner--lag"><span className="lag-wave">≋</span><div><strong>Opponent connection is slow</strong><small>The game will continue when their connection improves.</small></div></div>}{error && <div className="banner banner--error" role="alert"><span>!</span>{error}</div>}
    <section className="battle-layout"><div><FleetCounter title="YOUR SHIPS" sunk={ownSunk} /><BattleBoard label="Your board" own game={game} /></div><div><FleetCounter title="OPPONENT SHIPS" sunk={enemySunk} /><BattleBoard label="Opponent board" own={false} game={game} disabled={finished || !game.isYourTurn || network !== "connected" || busy} pendingShot={pendingShot} onFire={onFire} /></div></section>
    <footer className="battle-footer"><div className="legend"><span><i className="legend-miss" />Miss</span><span><i className="legend-hit">×</i>Hit</span><span><i className="legend-ship" />Your ship</span></div>{finished ? <button className="button button--primary" onClick={onLobby}>Back to games</button> : <button className="button button--ghost danger" onClick={onSurrender} disabled={busy}>Surrender</button>}</footer>
  </main>;
}

function ConnectionOverlay({ state, onRetry, onLogout }: { state: Exclude<NetworkState, "connected">; onRetry: () => void; onLogout: () => void }) { return <div className="connection-overlay" role="alertdialog" aria-modal="true" aria-labelledby="connection-title"><div className="connection-card"><div className="connection-icon" aria-hidden="true">!</div><h2 id="connection-title">{state === "offline" ? "You’re offline" : "Connection lost"}</h2><p>{state === "offline" ? "Check your internet connection. The game will resume automatically when you’re back online." : "The server is not responding. Your game is saved while we reconnect."}</p><div className="button-row"><button className="button button--primary" onClick={onRetry}>Retry</button><button className="button button--ghost" onClick={onLogout}>Sign out</button></div></div></div>; }

function ConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) { function keyDown(event: KeyboardEvent<HTMLDivElement>) { if (event.key === "Escape") onCancel(); } return <div className="dialog-backdrop" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onKeyDown={keyDown}><div className="dialog-icon">!</div><h2 id="confirm-title">Surrender the game?</h2><p>The other player will win. This cannot be undone.</p><div className="button-row"><button className="button button--ghost" autoFocus onClick={onCancel}>Keep playing</button><button className="button button--danger" onClick={onConfirm}>Surrender</button></div></div></div>; }

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<PlayerGameView | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [authNotice, setAuthNotice] = useState("");
  const [network, setNetwork] = useState<NetworkState>(navigator.onLine ? "connected" : "offline");
  const [connectionBlocked, setConnectionBlocked] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0); const [pendingShot, setPendingShot] = useState<Coordinate | null>(null); const [confirmingSurrender, setConfirmingSurrender] = useState(false);
  const pollVersion = useRef(0);
  const pollGameCode = useRef<string | null>(null);
  const applyGame = useCallback((next: PlayerGameView) => {
    if (pollGameCode.current !== next.gameCode) {
      pollGameCode.current = next.gameCode;
      pollVersion.current = next.version;
    } else {
      if (next.version < pollVersion.current) return;
      pollVersion.current = next.version;
    }
    setGame((current) => current?.gameCode === next.gameCode && current.version > next.version ? current : next);
  }, []);
  const logout = useCallback((notice = "") => { void auth.logout(); setSession(null); setGame(null); pollGameCode.current = null; pollVersion.current = 0; setBooting(false); setBusy(""); setError(""); setAuthNotice(notice); setConnectionBlocked(false); }, []);
  const handleFailure = useCallback((caught: unknown, fallback: string) => { if (caught instanceof SessionExpiredError || (caught instanceof ApiFailure && caught.status === 401)) { logout("Your session expired. Sign in again to continue."); return; } setError(caught instanceof Error ? caught.message : fallback); }, [logout]);

  useEffect(() => { let active = true; void auth.restoreSession().then((restored) => { if (active) setSession(restored); }).finally(() => { if (active) setBooting(false); }); return () => { active = false; }; }, []);

  useEffect(() => { if (!session) return; let active = true; void (async () => { setBooting(true); try { const state = await api.playerState(); if (!active) return; setNetwork("connected"); setConnectionBlocked(false); if (state.state === "PLAYING") { const response = await api.getGame(state.gameCode); if (active) applyGame(response.game); } } catch (caught) { if (active) { setNetwork(navigator.onLine ? "reconnecting" : "offline"); handleFailure(caught, "Could not restore your game."); } } finally { if (active) setBooting(false); } })(); return () => { active = false; }; }, [session, retryNonce, handleFailure, applyGame]);
  useEffect(() => { const offline = () => setNetwork("offline"); const online = () => { setNetwork("reconnecting"); setRetryNonce((value) => value + 1); }; window.addEventListener("offline", offline); window.addEventListener("online", online); return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); }; }, []);
  useEffect(() => {
    if (network !== "offline" || !game || game.status === "FINISHED") return;
    const timer = window.setTimeout(() => setConnectionBlocked(true), CONNECTION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [network, game?.gameCode, game?.status]);
  useEffect(() => {
    if (!session || !game || game.status === "FINISHED") return;
    let active = true; let controller = new AbortController(); let failures = 0; let watchdog: number | undefined; let lastSuccessAt = Date.now();
    if (pollGameCode.current !== game.gameCode) { pollGameCode.current = game.gameCode; pollVersion.current = game.version; }
    else pollVersion.current = Math.max(pollVersion.current, game.version);
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      const remaining = Math.max(0, CONNECTION_TIMEOUT_MS - (Date.now() - lastSuccessAt));
      watchdog = window.setTimeout(() => { if (active && navigator.onLine) { setNetwork("reconnecting"); setConnectionBlocked(true); } }, remaining);
    };
    void (async () => {
      while (active) {
        if (!navigator.onLine) { window.clearTimeout(watchdog); setNetwork("offline"); await delay(800); continue; }
        controller = new AbortController();
        armWatchdog();
        try {
          const update = await api.updates(game.gameCode, pollVersion.current, controller.signal);
          window.clearTimeout(watchdog);
          if (!active) break;
          failures = 0; lastSuccessAt = Date.now(); setNetwork("connected"); setConnectionBlocked(false);
          if (update.type === "GAME_UPDATED") applyGame(update.game);
          else { pollVersion.current = Math.max(pollVersion.current, update.version); setGame((current) => current ? { ...current, players: update.players } : current); }
        } catch (caught) {
          if (!active || (caught instanceof DOMException && caught.name === "AbortError")) break;
          if (caught instanceof SessionExpiredError || (caught instanceof ApiFailure && caught.status === 401)) { window.clearTimeout(watchdog); logout("Your session expired. Sign in again to continue."); break; }
          failures += 1;
          if (!navigator.onLine) { window.clearTimeout(watchdog); setNetwork("offline"); }
          await delay(Math.min(500 * 2 ** failures, 4000));
        }
      }
    })();
    return () => { active = false; window.clearTimeout(watchdog); controller.abort(); };
  }, [session, game?.gameCode, game?.status, retryNonce, logout, applyGame]);

  async function runGameAction(name: string, action: () => Promise<{ game: PlayerGameView }>) { if (!session || busy) return; setBusy(name); setError(""); try { const response = await action(); applyGame(response.game); } catch (caught) { handleFailure(caught, "That action could not be completed."); } finally { setBusy(""); } }
  async function fire(row: number, column: number) { if (!session || !game || busy || !game.isYourTurn || network !== "connected") return; setPendingShot({ row, column }); setBusy("fire"); setError(""); try { const response = await api.fire(game.gameCode, row, column); applyGame(response.game); await delay(360); } catch (caught) { handleFailure(caught, "That square could not be played."); } finally { setPendingShot(null); setBusy(""); } }

  if (booting && !session) return <main className="loading-screen"><ButtonSpinner /><h2>Loading…</h2></main>;
  if (!session) return <AuthScreen initialNotice={authNotice} onAuthenticated={(next) => { setSession(next); setAuthNotice(""); setBooting(true); }} />;
  let content;
  if (booting) content = <main className="loading-screen"><ButtonSpinner /><h2>Loading…</h2></main>;
  else if (!game) content = <Lobby username={session.username} network={network} busy={busy} error={error} onCreate={() => runGameAction("create", () => api.createGame())} onJoin={(code) => runGameAction("join", () => api.joinGame(code))} />;
  else if (game.status === "WAITING") content = <WaitingRoom game={game} busy={Boolean(busy)} error={error} onCancel={() => runGameAction("cancel", () => api.cancel(game.gameCode))} />;
  else if (game.status === "PLACEMENT") content = <FleetPlacement game={game} busy={Boolean(busy)} error={error} onSubmit={(ships) => runGameAction("fleet", () => api.placeFleet(game.gameCode, toPlacements(ships)))} onCancel={() => runGameAction("cancel", () => api.cancel(game.gameCode))} />;
  else content = <Battle game={game} network={network} busy={Boolean(busy)} error={error} pendingShot={pendingShot} onFire={fire} onSurrender={() => setConfirmingSurrender(true)} onLobby={() => { setGame(null); setError(""); }} />;
  return <div className="app-frame"><AppHeader username={session.username} network={network} onLogout={() => logout()} />{content}{connectionBlocked && network !== "connected" && game && <ConnectionOverlay state={network} onRetry={() => { setNetwork(navigator.onLine ? "reconnecting" : "offline"); setRetryNonce((value) => value + 1); }} onLogout={() => logout()} />}{confirmingSurrender && <ConfirmDialog onCancel={() => setConfirmingSurrender(false)} onConfirm={() => { setConfirmingSurrender(false); void runGameAction("surrender", () => api.surrender(game!.gameCode)); }} />}</div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");
void createAuthProvider().then((provider) => {
  auth = provider;
  api = createApi(auth);
  createRoot(root).render(<StrictMode><App /></StrictMode>);
}).catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : "The application could not start.";
});
