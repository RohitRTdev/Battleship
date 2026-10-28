import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useMatch, useNavigate } from "react-router-dom";
import type { AttackView, ConnectionStatus, Coordinate, PlayerGameView, PlayerSummary } from "@battleship/game-contract";
import { ApiFailure, SessionExpiredError, createApi } from "./api";
import { authenticationErrorMessage, createAuthProvider, type AuthProvider, type UserSession } from "./auth";
import { BOARD_SIZE, FLEET, autoPlaceFleet, cellsFor, toPlacements, validatePlacement } from "./fleet";
import type { Orientation, PlacedShip } from "./fleet";
import { GameGate, HomeRedirect, LobbyGate, LoginGate, MatchmakingGate, RequireSession, gamePath, matchmakingPath, requestedPath } from "./routing";
import "./styles.css";

const COLUMN_LABELS = "ABCDEFGHIJ".split("");
const CONNECTION_TIMEOUT_MS = 6_000;

type Session = UserSession;
type NetworkState = "connected" | "reconnecting" | "offline";

let auth: AuthProvider;
let api: ReturnType<typeof createApi>;
let gameAudioContext: AudioContext | null = null;

function coordinateKey({ row, column }: Coordinate): string { return `${row}:${column}`; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

type GameSound = "hit" | "miss" | "sunk" | "win" | "loss";

function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  gameAudioContext ??= new AudioContext();
  return gameAudioContext;
}

function unlockGameAudio(): void {
  const context = audioContext();
  if (context?.state === "suspended") void context.resume();
}

function playGameSound(sound: GameSound): void {
  const context = audioContext();
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(.0001, now);
  master.gain.exponentialRampToValueAtTime(.16, now + .012);
  master.connect(context.destination);
  const tone = (frequency: number, start: number, duration: number, type: OscillatorType = "sine", volume = 1) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now + start);
    gain.gain.setValueAtTime(.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(volume, now + start + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, now + start + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(now + start);
    oscillator.stop(now + start + duration + .02);
  };
  if (sound === "miss") { tone(190, 0, .15, "sine", .45); tone(120, .08, .22, "sine", .25); }
  if (sound === "hit") { tone(110, 0, .18, "sawtooth", .8); tone(72, .035, .25, "square", .35); }
  if (sound === "sunk") { tone(180, 0, .42, "sawtooth", .8); tone(120, .1, .5, "square", .45); tone(62, .2, .62, "sine", .9); }
  if (sound === "win") { [392, 523, 659, 784].forEach((frequency, index) => tone(frequency, index * .12, .42, "triangle", .7)); tone(1047, .5, .8, "sine", .7); }
  if (sound === "loss") { [330, 277, 220, 165].forEach((frequency, index) => tone(frequency, index * .18, .38, "triangle", .55)); }
  master.gain.exponentialRampToValueAtTime(.0001, now + (sound === "win" || sound === "loss" ? 1.25 : .9));
}

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

function Lobby({ username, network, busy, error, onCreate, onJoin, onPublic }: { username: string; network: NetworkState; busy: string; error: string; onCreate: () => void; onJoin: (code: string) => void; onPublic: () => void }) {
  const [code, setCode] = useState("");
  return <main className="lobby page-enter">
    <section className="lobby-intro"><p className="eyebrow">PLAY</p><h1>Welcome, <em>{username}</em></h1><p>Create a new game or join one with a code.</p></section>
    {error && <div className="banner banner--error" role="alert"><span>!</span>{error}</div>}
    <section className="lobby-grid">
      <article className="mission-card mission-card--public"><p className="eyebrow">PUBLIC MATCH</p><h2>Find an opponent</h2><p>Enter the public queue and play the next available commander.</p><ul><li>First-in, first-out matching</li><li>Starts as soon as two players are ready</li></ul><button className="button button--primary" onClick={onPublic} disabled={Boolean(busy)}>{busy === "matchmaking" && <ButtonSpinner />}Find match</button></article>
      <article className="mission-card mission-card--create"><p className="eyebrow">NEW GAME</p><h2>Create a game</h2><p>Get a private code to share with another player.</p><ul><li>Private 8-character code</li><li>Creator plays first</li></ul><button className="button button--primary" onClick={onCreate} disabled={Boolean(busy)}>{busy === "create" && <ButtonSpinner />}Create game</button></article>
      <article className="mission-card"><p className="eyebrow">JOIN GAME</p><h2>Enter a code</h2><p>Use the code shared by the player who created the game.</p><label className="code-label">GAME CODE<input className="code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, 8))} placeholder="ABCD1234" maxLength={8} autoCapitalize="characters" /></label><button className="button button--secondary" onClick={() => onJoin(code)} disabled={Boolean(busy) || code.length !== 8}>{busy === "join" && <ButtonSpinner />}Join game</button></article>
    </section>
  </main>;
}

function MatchmakingScreen({ startedAt, busy, error, onCancel }: { startedAt: string; busy: boolean; error: string; onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  return <main className="game-shell page-enter"><section className="waiting-card matchmaking-card">
    <div className="waiting-radar" aria-hidden="true"><span /><i /><b /></div>
    <p className="eyebrow">PUBLIC MATCH</p><h1>Searching for an opponent</h1>
    <p className="muted">You’ll enter fleet placement as soon as another player is found.</p>
    <div className="search-time"><span>TIME SEARCHING</span><strong>{minutes}:{seconds}</strong></div>
    {error && <div className="banner banner--error" role="alert">{error}</div>}
    <button className="button button--ghost danger" onClick={onCancel} disabled={busy}>{busy && <ButtonSpinner />}Cancel search</button>
  </section></main>;
}

function Presence({ status }: { status: ConnectionStatus }) {
  const label = status === "CONNECTED" ? "Connected" : status === "LAGGING" ? "Connection slow" : status === "NOT_JOINED" ? "Not joined" : "Connecting";
  return <span className={`presence presence--${status.toLowerCase()}`}><i />{label}</span>;
}

function PlayerCard({ player, isYou, active, gameComplete = false }: { player?: PlayerSummary; isYou?: boolean; active?: boolean; gameComplete?: boolean }) {
  return <div className={`player-card ${active ? "player-card--active" : ""} ${!player ? "player-card--empty" : ""}`}><div className="avatar">{player ? player.username.slice(0, 1).toUpperCase() : "?"}</div><div><strong>{player?.username ?? "Waiting for player"}{isYou && <small> YOU</small>}</strong>{player ? gameComplete ? <span className="muted small">Game complete</span> : <Presence status={player.connectionStatus} /> : <span className="muted small">Share the game code</span>}</div>{active && <span className="turn-tag">TURN</span>}</div>;
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

function FleetCounter({ title, sunkLengths }: { title: string; sunkLengths: number[] }) {
  const unmatched = [...sunkLengths];
  const ships = FLEET.map((ship) => {
    const sunkIndex = unmatched.indexOf(ship.length);
    if (sunkIndex >= 0) unmatched.splice(sunkIndex, 1);
    return { ...ship, sunk: sunkIndex >= 0 };
  });
  return <div className="fleet-counter"><div className="fleet-counter__label"><span>{title}</span><strong>{sunkLengths.length}<small>/5 SUNK</small></strong></div><div className="fleet-icons">{ships.map((ship) => <div key={ship.id} className={`fleet-icon ${ship.sunk ? "fleet-icon--sunk" : ""}`} aria-label={`${ship.name}: ${ship.sunk ? "sunk" : "afloat"}`} title={`${ship.name} · ${ship.sunk ? "Sunk" : "Afloat"}`}><span className="fleet-icon__ship"><i />{Array.from({ length: ship.length }, (_, index) => <b key={index} />)}</span><em>{ship.sunk ? "×" : "✓"}</em></div>)}</div></div>;
}

function SinkCelebration({ count, lost }: { count: number; lost: boolean }) {
  return <div className={`sink-celebration ${lost ? "sink-celebration--lost" : ""}`} role="status" aria-live="assertive"><div className="sink-burst" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--spark": index } as CSSProperties} />)}</div><div className="sink-medal"><span className="sink-medal__ship">▰</span><small>{lost ? "ENEMY STRIKE" : "DIRECT HIT"}</small><strong>{lost ? "SHIP LOST!" : "SHIP SUNK!"}</strong><b>{lost ? `FLEET DAMAGE ×${count}` : `FLEET STREAK ×${count}`}</b></div></div>;
}

function GameResultCelebration({ won }: { won: boolean }) {
  return <div className={`result-celebration ${won ? "result-celebration--win" : "result-celebration--loss"}`} aria-hidden="true">{won && <div className="confetti">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ "--piece": index } as CSSProperties} />)}</div>}<div className="result-emblem"><span>{won ? "★" : "⌁"}</span><strong>{won ? "VICTORY" : "DEFEAT"}</strong></div></div>;
}

function Battle({ game, network, busy, error, pendingShot, onFire, onSurrender, onLobby }: { game: PlayerGameView; network: NetworkState; busy: boolean; error: string; pendingShot: Coordinate | null; onFire: (row: number, column: number) => void; onSurrender: () => void; onLobby: () => void }) {
  const previous = useRef({ yourAttacks: game.yourAttacks.length, opponentAttacks: game.opponentAttacks.length, finished: game.status === "FINISHED" });
  const sinkTimer = useRef<number | null>(null);
  const [sinkCelebration, setSinkCelebration] = useState<{ count: number; lost: boolean } | null>(null);
  const you = game.players.find((player) => player.id === game.yourPlayerId)!;
  const opponent = game.players.find((player) => player.id !== game.yourPlayerId);
  const ownSunkLengths = game.yourFleet?.filter((ship) => ship.sunk).map((ship) => ship.length) ?? [];
  const enemySunkLengths = game.yourAttacks.filter((attack) => attack.result === "SUNK" || attack.result === "WIN").map((attack, index) => attack.sunkShipLength ?? FLEET[index]?.length ?? 2);
  const finished = game.status === "FINISHED"; const won = game.winnerPlayerId === game.yourPlayerId; const cancelled = game.completionReason === "CANCELLED";

  useEffect(() => {
    const last = previous.current;
    const latestYourAttack = game.yourAttacks.length > last.yourAttacks ? game.yourAttacks.at(-1) : undefined;
    const latestOpponentAttack = game.opponentAttacks.length > last.opponentAttacks ? game.opponentAttacks.at(-1) : undefined;
    const newFinish = game.status === "FINISHED" && !last.finished && !cancelled;
    previous.current = { yourAttacks: game.yourAttacks.length, opponentAttacks: game.opponentAttacks.length, finished: game.status === "FINISHED" };
    if (newFinish) playGameSound(won ? "win" : "loss");
    else {
      const result = latestYourAttack?.result ?? latestOpponentAttack?.result;
      if (result === "MISS") playGameSound("miss");
      if (result === "HIT") playGameSound("hit");
      if (result === "SUNK" || result === "WIN") playGameSound("sunk");
    }
    const sankOpponent = latestYourAttack?.result === "SUNK" || latestYourAttack?.result === "WIN";
    const lostShip = latestOpponentAttack?.result === "SUNK" || latestOpponentAttack?.result === "WIN";
    if (newFinish) {
      if (sinkTimer.current !== null) window.clearTimeout(sinkTimer.current);
      sinkTimer.current = null;
      setSinkCelebration(null);
    } else if (sankOpponent || lostShip) {
      setSinkCelebration({ count: sankOpponent ? enemySunkLengths.length : ownSunkLengths.length, lost: lostShip });
      if (sinkTimer.current !== null) window.clearTimeout(sinkTimer.current);
      sinkTimer.current = window.setTimeout(() => { setSinkCelebration(null); sinkTimer.current = null; }, 2100);
    }
  }, [game.version, game.status, game.yourAttacks, game.opponentAttacks, won, cancelled, enemySunkLengths.length, ownSunkLengths.length]);
  useEffect(() => () => { if (sinkTimer.current !== null) window.clearTimeout(sinkTimer.current); }, []);

  return <main className={`battle page-enter ${finished ? "battle--finished" : ""}`}><section className={`turn-banner ${game.isYourTurn ? "turn-banner--yours" : ""} ${finished ? won ? "turn-banner--win" : "turn-banner--loss" : ""}`} aria-live="polite"><div><p className="eyebrow">{finished ? "GAME OVER" : "CURRENT TURN"}</p><h1>{finished ? cancelled ? "Game cancelled" : won ? "You won" : "You lost" : game.isYourTurn ? "Your turn" : `${opponent?.username ?? "Opponent"}'s turn`}</h1><p>{finished ? game.completionReason === "SURRENDER" ? (won ? "The other player surrendered." : "You surrendered.") : cancelled ? "The game ended without a winner." : won ? "You sank every enemy ship." : "Your fleet was sunk." : game.isYourTurn ? "Choose a square on the enemy board." : "Waiting for the other player."}</p></div><GameCode code={game.gameCode} /></section>
    <section className="combatants"><PlayerCard player={you} isYou active={!finished && game.currentTurn === you.id} gameComplete={finished} /><div className="combat-line"><i /><span>VS</span><i /></div><PlayerCard player={opponent} active={!finished && game.currentTurn === opponent?.id} gameComplete={finished} /></section>
    {opponent?.connectionStatus === "LAGGING" && !finished && <div className="banner banner--lag"><span className="lag-wave">≋</span><div><strong>Opponent connection is slow</strong><small>The game will continue when their connection improves.</small></div></div>}{error && <div className="banner banner--error" role="alert"><span>!</span>{error}</div>}
    <section className="battle-layout"><div><FleetCounter title="YOUR SHIPS" sunkLengths={ownSunkLengths} /><BattleBoard label="Your board" own game={game} /></div><div><FleetCounter title="OPPONENT SHIPS" sunkLengths={enemySunkLengths} /><BattleBoard label="Opponent board" own={false} game={game} disabled={finished || !game.isYourTurn || network !== "connected" || busy} pendingShot={pendingShot} onFire={onFire} /></div></section>
    <footer className="battle-footer"><div className="legend"><span><i className="legend-miss" />Miss</span><span><i className="legend-hit">×</i>Hit</span><span><i className="legend-ship" />Your ship</span></div>{finished ? <button className="button button--primary" onClick={onLobby}>Back to games</button> : <button className="button button--ghost danger" onClick={onSurrender} disabled={busy}>Surrender</button>}</footer>
    {sinkCelebration && <SinkCelebration count={sinkCelebration.count} lost={sinkCelebration.lost} />}{finished && !cancelled && <GameResultCelebration won={won} />}
  </main>;
}

function ConnectionOverlay({ state, onRetry, onLogout, searching = false }: { state: Exclude<NetworkState, "connected">; onRetry: () => void; onLogout: () => void; searching?: boolean }) { return <div className="connection-overlay" role="alertdialog" aria-modal="true" aria-labelledby="connection-title"><div className="connection-card"><div className="connection-icon" aria-hidden="true">!</div><h2 id="connection-title">{state === "offline" ? "You’re offline" : "Connection lost"}</h2><p>{state === "offline" ? `Check your internet connection. Your ${searching ? "search" : "game"} will resume automatically when you’re back online.` : `The server is not responding. Your ${searching ? "place in the queue" : "game"} is saved while we reconnect.`}</p><div className="button-row"><button className="button button--primary" onClick={onRetry}>Retry</button><button className="button button--ghost" onClick={onLogout}>Sign out</button></div></div></div>; }

function ConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) { function keyDown(event: KeyboardEvent<HTMLDivElement>) { if (event.key === "Escape") onCancel(); } return <div className="dialog-backdrop" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onKeyDown={keyDown}><div className="dialog-icon">!</div><h2 id="confirm-title">Surrender the game?</h2><p>The other player will win. This cannot be undone.</p><div className="button-row"><button className="button button--ghost" autoFocus onClick={onCancel}>Keep playing</button><button className="button button--danger" onClick={onConfirm}>Surrender</button></div></div></div>; }

function LoadingScreen() { return <main className="loading-screen"><ButtonSpinner /><h2>Loading…</h2></main>; }

function RouteMessage({ eyebrow, title, message, actionLabel, onAction }: { eyebrow: string; title: string; message: string; actionLabel: string; onAction: () => void }) {
  return <main className="game-shell page-enter"><section className="waiting-card compact-wait"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{message}</p><button className="button button--primary" onClick={onAction}>{actionLabel}</button></section></main>;
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const gameRoute = useMatch("/games/:gameCode");
  const matchmakingRoute = useMatch(matchmakingPath);
  const routedGameCode = gameRoute?.params.gameCode?.trim().toUpperCase() ?? null;
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [playerStateReadyFor, setPlayerStateReadyFor] = useState<string | null>(null);
  const [activeGameCode, setActiveGameCode] = useState<string | null>(null);
  const [searchStartedAt, setSearchStartedAt] = useState<string | null>(null);
  const [game, setGame] = useState<PlayerGameView | null>(null);
  const [loadingGame, setLoadingGame] = useState(false);
  const [gameLoadError, setGameLoadError] = useState("");
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [authNotice, setAuthNotice] = useState("");
  const [network, setNetwork] = useState<NetworkState>(navigator.onLine ? "connected" : "offline");
  const [connectionBlocked, setConnectionBlocked] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0); const [pendingShot, setPendingShot] = useState<Coordinate | null>(null); const [confirmingSurrender, setConfirmingSurrender] = useState(false);
  const pollVersion = useRef(0);
  const pollGameCode = useRef<string | null>(null);
  const matchmakingController = useRef<AbortController | null>(null);
  const checkingPlayerState = Boolean(session && playerStateReadyFor !== session.username);
  const applyGame = useCallback((next: PlayerGameView) => {
    setSearchStartedAt(null);
    if (pollGameCode.current !== next.gameCode) {
      pollGameCode.current = next.gameCode;
      pollVersion.current = next.version;
    } else {
      if (next.version < pollVersion.current) return;
      pollVersion.current = next.version;
    }
    setActiveGameCode((current) => next.status === "FINISHED" ? (current === next.gameCode ? null : current) : next.gameCode);
    setGame((current) => current?.gameCode === next.gameCode && current.version > next.version ? current : next);
  }, []);
  const logout = useCallback((notice = "") => { matchmakingController.current?.abort(); void auth.logout(); setSession(null); setActiveGameCode(null); setSearchStartedAt(null); setGame(null); setGameLoadError(""); pollGameCode.current = null; pollVersion.current = 0; setBusy(""); setError(""); setAuthNotice(notice); setConnectionBlocked(false); setConfirmingSurrender(false); navigate("/login", { replace: true }); }, [navigate]);
  const handleFailure = useCallback((caught: unknown, fallback: string) => { if (caught instanceof SessionExpiredError || (caught instanceof ApiFailure && caught.status === 401)) { logout("Your session expired. Sign in again to continue."); return; } setError(caught instanceof Error ? caught.message : fallback); }, [logout]);

  useEffect(() => { const unlock = () => unlockGameAudio(); window.addEventListener("pointerdown", unlock, { once: true }); window.addEventListener("keydown", unlock, { once: true }); return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); }; }, []);
  useEffect(() => { let active = true; void auth.restoreSession().then((restored) => { if (active) setSession(restored); }).finally(() => { if (active) setCheckingSession(false); }); return () => { active = false; }; }, []);

  useEffect(() => {
    if (!session) { setPlayerStateReadyFor(null); setActiveGameCode(null); setSearchStartedAt(null); return; }
    let active = true;
    void (async () => {
      setPlayerStateReadyFor(null);
      try {
        const state = await api.playerState();
        if (!active) return;
        setNetwork("connected"); setConnectionBlocked(false);
        setActiveGameCode(state.state === "PLAYING" ? state.gameCode : null);
        setSearchStartedAt(state.state === "SEARCHING" ? state.searchStartedAt : null);
      } catch (caught) {
        if (active) { setNetwork(navigator.onLine ? "reconnecting" : "offline"); handleFailure(caught, "Could not restore your game."); }
      } finally { if (active) setPlayerStateReadyFor(session.username); }
    })();
    return () => { active = false; };
  }, [session, retryNonce, handleFailure]);
  useEffect(() => {
    if (!session || checkingPlayerState || searchStartedAt || !routedGameCode) { setGameLoadError(""); setLoadingGame(false); return; }
    if (game?.gameCode === routedGameCode) { setGameLoadError(""); setLoadingGame(false); return; }
    const controller = new AbortController();
    let active = true;
    setGame(null); setGameLoadError(""); setError(""); setLoadingGame(true); setConfirmingSurrender(false);
    void api.getGame(routedGameCode, controller.signal).then(({ game: loaded }) => {
      if (!active) return;
      applyGame(loaded);
      if (gameRoute?.params.gameCode !== loaded.gameCode) navigate(gamePath(loaded.gameCode), { replace: true });
    }).catch((caught: unknown) => {
      if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
      if (caught instanceof SessionExpiredError || (caught instanceof ApiFailure && caught.status === 401)) { logout("Your session expired. Sign in again to continue."); return; }
      setGameLoadError(caught instanceof Error ? caught.message : "That game could not be loaded.");
    }).finally(() => { if (active) setLoadingGame(false); });
    return () => { active = false; controller.abort(); };
  }, [session, checkingPlayerState, searchStartedAt, routedGameCode, game?.gameCode, gameRoute?.params.gameCode, applyGame, logout, navigate]);
  useEffect(() => { const offline = () => setNetwork("offline"); const online = () => { setNetwork("reconnecting"); setRetryNonce((value) => value + 1); }; window.addEventListener("offline", offline); window.addEventListener("online", online); return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); }; }, []);
  useEffect(() => {
    const waitingForGame = Boolean(game && game.gameCode === routedGameCode && game.status !== "FINISHED");
    const waitingForMatch = Boolean(matchmakingRoute && searchStartedAt);
    if (network !== "offline" || (!waitingForGame && !waitingForMatch)) return;
    const timer = window.setTimeout(() => setConnectionBlocked(true), CONNECTION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [network, routedGameCode, game?.gameCode, game?.status, matchmakingRoute, searchStartedAt]);
  useEffect(() => {
    if (!session || !game || game.gameCode !== routedGameCode || game.status === "FINISHED") return;
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
  }, [session, routedGameCode, game?.gameCode, game?.status, retryNonce, logout, applyGame]);

  useEffect(() => {
    if (!session || !matchmakingRoute || !searchStartedAt || busy === "cancel-search") return;
    let active = true; let failures = 0; let watchdog: number | undefined; let lastSuccessAt = Date.now();
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      const remaining = Math.max(0, CONNECTION_TIMEOUT_MS - (Date.now() - lastSuccessAt));
      watchdog = window.setTimeout(() => { if (active && navigator.onLine) { setNetwork("reconnecting"); setConnectionBlocked(true); } }, remaining);
    };
    void (async () => {
      while (active) {
        if (!navigator.onLine) { window.clearTimeout(watchdog); setNetwork("offline"); await delay(800); continue; }
        const controller = new AbortController();
        matchmakingController.current = controller;
        armWatchdog();
        try {
          const update = await api.matchmakingUpdates(controller.signal);
          window.clearTimeout(watchdog);
          if (!active) break;
          failures = 0; lastSuccessAt = Date.now(); setNetwork("connected"); setConnectionBlocked(false);
          if (update.type === "MATCH_FOUND") {
            setSearchStartedAt(null); setActiveGameCode(update.gameCode); navigate(gamePath(update.gameCode), { replace: true }); break;
          }
          if (update.type === "NOT_SEARCHING") {
            setSearchStartedAt(null); setActiveGameCode(null); navigate("/lobby", { replace: true }); break;
          }
          setSearchStartedAt(update.searchStartedAt);
        } catch (caught) {
          if (!active || (caught instanceof DOMException && caught.name === "AbortError")) break;
          if (caught instanceof SessionExpiredError || (caught instanceof ApiFailure && caught.status === 401)) { window.clearTimeout(watchdog); logout("Your session expired. Sign in again to continue."); break; }
          failures += 1;
          if (!navigator.onLine) setNetwork("offline");
          await delay(Math.min(500 * 2 ** failures, 4000));
        }
      }
    })();
    return () => { active = false; window.clearTimeout(watchdog); matchmakingController.current?.abort(); matchmakingController.current = null; };
  }, [session, matchmakingRoute, searchStartedAt, busy, retryNonce, logout, navigate]);

  async function runGameAction(name: string, action: () => Promise<{ game: PlayerGameView }>): Promise<PlayerGameView | null> { if (!session || busy) return null; setBusy(name); setError(""); try { const response = await action(); applyGame(response.game); return response.game; } catch (caught) { handleFailure(caught, "That action could not be completed."); return null; } finally { setBusy(""); } }
  async function startGame(name: "create" | "join", action: () => Promise<{ game: PlayerGameView }>) { const next = await runGameAction(name, action); if (next) navigate(gamePath(next.gameCode)); }
  async function startMatchmaking() {
    if (!session || busy) return;
    setBusy("matchmaking"); setError("");
    try {
      const state = await api.startMatchmaking();
      if (state.state === "PLAYING") { setSearchStartedAt(null); setActiveGameCode(state.gameCode); navigate(gamePath(state.gameCode)); }
      else if (state.state === "SEARCHING") { setActiveGameCode(null); setSearchStartedAt(state.searchStartedAt); navigate(matchmakingPath); }
    } catch (caught) { handleFailure(caught, "Could not start public matchmaking."); }
    finally { setBusy(""); }
  }
  async function cancelMatchmaking() {
    if (!session || busy) return;
    setBusy("cancel-search"); setError(""); matchmakingController.current?.abort();
    try {
      const state = await api.cancelMatchmaking();
      if (state.state === "PLAYING") { setSearchStartedAt(null); setActiveGameCode(state.gameCode); navigate(gamePath(state.gameCode), { replace: true }); }
      else { setSearchStartedAt(null); setActiveGameCode(null); navigate("/lobby", { replace: true }); }
    } catch (caught) { handleFailure(caught, "Could not cancel matchmaking."); }
    finally { setBusy(""); }
  }
  async function fire(row: number, column: number) { if (!session || !game || busy || !game.isYourTurn || network !== "connected") return; unlockGameAudio(); setPendingShot({ row, column }); setBusy("fire"); setError(""); try { const response = await api.fire(game.gameCode, row, column); applyGame(response.game); await delay(360); } catch (caught) { handleFailure(caught, "That square could not be played."); } finally { setPendingShot(null); setBusy(""); } }

  const loading = <LoadingScreen />;
  const checkingIdentity = checkingSession || Boolean(session && checkingPlayerState);
  const authenticate = (next: Session) => { const destination = requestedPath(location.state) ?? "/"; setSession(next); setAuthNotice(""); navigate(destination, { replace: true }); };
  const searching = Boolean(searchStartedAt);
  const lobby = session ? <LobbyGate activeGameCode={activeGameCode} searching={searching} checking={checkingPlayerState} loading={loading}><Lobby username={session.username} network={network} busy={busy} error={error} onPublic={() => void startMatchmaking()} onCreate={() => void startGame("create", () => api.createGame())} onJoin={(code) => void startGame("join", () => api.joinGame(code))} /></LobbyGate> : null;
  const matchmaking = session ? <MatchmakingGate activeGameCode={activeGameCode} searching={searching} checking={checkingPlayerState} loading={loading}><MatchmakingScreen startedAt={searchStartedAt!} busy={busy === "cancel-search"} error={error} onCancel={() => void cancelMatchmaking()} /></MatchmakingGate> : null;
  let gameContent = loading;
  if (!loadingGame && gameLoadError) gameContent = <RouteMessage eyebrow="GAME UNAVAILABLE" title="Game could not be opened" message={gameLoadError} actionLabel="Back to lobby" onAction={() => navigate("/lobby")} />;
  else if (!loadingGame && game?.gameCode === routedGameCode) {
    if (game.status === "WAITING") gameContent = <WaitingRoom game={game} busy={Boolean(busy)} error={error} onCancel={() => void runGameAction("cancel", () => api.cancel(game.gameCode))} />;
    else if (game.status === "PLACEMENT") gameContent = <FleetPlacement game={game} busy={Boolean(busy)} error={error} onSubmit={(ships) => void runGameAction("fleet", () => api.placeFleet(game.gameCode, toPlacements(ships)))} onCancel={() => void runGameAction("cancel", () => api.cancel(game.gameCode))} />;
    else gameContent = <Battle game={game} network={network} busy={Boolean(busy)} error={error} pendingShot={pendingShot} onFire={fire} onSurrender={() => setConfirmingSurrender(true)} onLobby={() => { setError(""); navigate("/lobby"); }} />;
  }
  const frame = (content: ReactNode, overlays: "none" | "game" | "matchmaking" = "none") => session ? <div className="app-frame"><AppHeader username={session.username} network={network} onLogout={() => logout()} />{content}{overlays !== "none" && connectionBlocked && network !== "connected" && (overlays === "matchmaking" || game?.gameCode === routedGameCode) && <ConnectionOverlay state={network} searching={overlays === "matchmaking"} onRetry={() => { setNetwork(navigator.onLine ? "reconnecting" : "offline"); setRetryNonce((value) => value + 1); }} onLogout={() => logout()} />}{overlays === "game" && confirmingSurrender && game?.gameCode === routedGameCode && <ConfirmDialog onCancel={() => setConfirmingSurrender(false)} onConfirm={() => { setConfirmingSurrender(false); void runGameAction("surrender", () => api.surrender(game.gameCode)); }} />}</div> : loading;

  return <Routes>
    <Route path="/" element={<HomeRedirect authenticated={Boolean(session)} checking={checkingIdentity} activeGameCode={activeGameCode} searching={searching} loading={loading} />} />
    <Route path="/login" element={<LoginGate authenticated={Boolean(session)} checking={checkingIdentity} activeGameCode={activeGameCode} searching={searching} loading={loading}><AuthScreen initialNotice={authNotice} onAuthenticated={authenticate} /></LoginGate>} />
    <Route path="/lobby" element={<RequireSession authenticated={Boolean(session)} checking={checkingSession} loading={loading}>{frame(lobby)}</RequireSession>} />
    <Route path={matchmakingPath} element={<RequireSession authenticated={Boolean(session)} checking={checkingSession} loading={loading}>{frame(matchmaking, "matchmaking")}</RequireSession>} />
    <Route path="/games/:gameCode" element={<RequireSession authenticated={Boolean(session)} checking={checkingSession} loading={loading}><GameGate activeGameCode={activeGameCode} searching={searching} checking={checkingPlayerState} loading={loading} routedGameCode={routedGameCode}>{frame(gameContent, "game")}</GameGate></RequireSession>} />
    <Route path="*" element={<RequireSession authenticated={Boolean(session)} checking={checkingSession} loading={loading}>{frame(<RouteMessage eyebrow="404" title="Page not found" message="That page does not exist." actionLabel="Back to lobby" onAction={() => navigate("/lobby")} />)}</RequireSession>} />
  </Routes>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");
void createAuthProvider().then((provider) => {
  auth = provider;
  api = createApi(auth);
  createRoot(root).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
}).catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : "The application could not start.";
});
