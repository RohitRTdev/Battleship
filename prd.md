# FleetSync product requirements

**Source:** `CloudHack.pdf`, version 1.0, 18 September 2026, team CloudHack.

> This is a Markdown summary of the original proposal, not a statement of current implementation. Its proposed sticky in-memory, Valkey and Kubernetes configurations were subsequently revised. The current branches use PostgreSQL on `master` and etcd-based clusters on `config-2`; consult their code and README for current behavior.

## 1. Problem and objective

Build a server-authoritative, two-player naval strategy game on a 10 × 10 grid. Players place a fleet and alternate attacks until a fleet is destroyed. The server decides all state transitions and protects hidden ship positions.

Use the game as a reproducible workload to compare distributed architectures on latency, failure recovery, scalability, correctness, security, operational complexity and cost. The original proposal compared sticky in-memory game servers against stateless servers using a shared active-state tier.

## 2. Scope and assumptions

**In scope:** guest identity, private rooms, public matchmaking, fleet placement, authoritative turns and outcomes, reconnect, player-filtered views, completed-game history, deployment modes, observability, bot workloads, failure injection and security testing. The proposed fleet lengths are 5, 4, 3, 3 and 2.

**Out of scope:** chat, payments, advertising, native mobile apps, voice, social graphs, global rankings, tournaments, spectators, computer vision, real-money prizes, games with more than two players, and strong protection against collusion. An AI opponent and cosmetic animation were stretch goals.

The proposal assumes one region and availability zone for the MVP, server-controlled deadlines, at most one active match per account/guest, a maximum match duration of 30 minutes and at most 200 accepted commands per match. It targets a benchmark capacity of 2,000 WebSockets.

**Privacy and retention targets:** hide unrevealed opponent coordinates; retain completed summaries for 30 days and board coordinates/command payloads for seven days; keep guest tokens out of logs and delete expired data. Use synthetic accounts and matches for benchmarks.

## 3. Users and scenarios

- Players create or join games, use matchmaking, play, reconnect and inspect history.
- Operators deploy and observe configurations; developers maintain rules and clients; evaluators run load, fault and security experiments.
- Representative scenarios include a normal private match, a disconnect during replica loss, racing or malicious commands, and a burst of players entering matchmaking.

## 4. Functional requirements

| ID | Requirement | Original acceptance target |
| --- | --- | --- |
| FR-1 | Private rooms and FIFO matchmaking; one active assignment per player. | 100 simultaneous joins produce 50 distinct two-player matches, with no duplicate assignment. |
| FR-2 | Validate hidden fleet composition, bounds, overlap, adjacency and actor. | Valid fixtures succeed; invalid fixtures return stable errors without changing state. |
| FR-3 | Validate and atomically apply authoritative attacks. | Golden matches produce expected results; illegal commands leave version and board unchanged. |
| FR-4 | Deliver ordered player-filtered events and snapshots. | Players converge after 200 commands without disclosing unrevealed cells. |
| FR-5 | Reconnect with a snapshot and events after the last acknowledged sequence. | Recover the permitted view after a 20-second disconnect. |
| FR-6 | Idempotency and concurrency controls with match, actor, expected version and command ID. | 1,000 duplicate/racing pairs produce one committed transition per turn and no divergent snapshots. |
| FR-7 | Close games and persist completed history exactly once. | Repeated terminal commands yield one history row and the same outcome. |
| FR-8 | Select deployment modes and export per-run observability. | Each experiment exports the defined metrics with configuration and run ID. |
| FR-9 | Authenticate, protect private state, rate-limit and audit violations. | No hidden coordinates leak; traffic beyond 20 commands/player/second is rejected or limited. |
| FR-10 | Seeded headless bots for legal/adversarial play and reconnect. | A seed and configuration reproduce the logical trace and expected winner. |

The original requirements specified WebSocket events and HTTPS commands. Later project decisions may use a different transport; verify current behavior in code.

## 5. Non-functional targets

| ID | Original target |
| --- | --- |
| NFR-1 | At 500 concurrent matches and 100 accepted attacks/s for 10 minutes, client-measured p99 move latency ≤250 ms. |
| NFR-2 | At 100 queue joins/s for two minutes, p95 matchmaking latency ≤2 seconds when a compatible opponent is waiting. |
| NFR-3 | Maintain 2,000 WebSockets for 10 minutes, with ≥99.5% successful handshakes and ≤0.5% unintended disconnects. |
| NFR-4 | After terminating a game replica during 200 active matches, ≥99% of affected clients resume within 8 seconds in shared-state mode, with no lost committed move. |
| NFR-5 | One million generated commands, including 10% duplicate, stale, concurrent or unauthorized commands, produce zero double turns, regressions, duplicate terminal records or mismatched permitted views. |
| NFR-6 | Across 2,000 security/privacy probes, disclose no unrevealed opponent coordinates or guest tokens. |
| NFR-7 | During a five-minute attack of 200 invalid commands/s from 20 clients, legitimate p99 ≤500 ms and ≥99% of legitimate commands receive a response. |
| NFR-8 | Report compute, active-state, database, load-balancer and network cost in INR and USD per 1,000 completed matches and per 1,000 connection-minutes. |

These are proposal targets, not measured results.

## 6. Original architecture proposal

The original design proposed a React client, game API/WebSocket pods, a load balancer, Valkey for active shared state, PostgreSQL for history/users, a matchmaking service, and Kubernetes with Prometheus, OpenTelemetry and Grafana. It specified three experimental configurations:

- **C1:** two fixed game pods with sticky match routing and in-memory active state; PostgreSQL stores completed summaries.
- **C2:** two fixed stateless game pods using Valkey for active snapshots, versions, command results and event streams.
- **C3:** C2 with horizontal autoscaling from two to ten pods.

The proposed consistency model used version-checked atomic state changes, command IDs, filtered per-player projections, snapshot/event resynchronization and a completion outbox. C1 deliberately demonstrates match loss on owner failure; C2/C3 aim to preserve committed state across game-pod failure.

These choices are retained here as historical context. They are not an instruction to add Valkey, Kubernetes or WebSockets to the current project.

## 7. Evaluation plan

The PRD specifies seeded workloads at 50, 100, 250 and 500 concurrent matches, 2,000 connections, a 50-to-500-match burst and adversarial traffic. It proposes identical seeds, controlled environments, one warm-up followed by five repetitions, and reporting medians and 95% bootstrap confidence intervals.

- **E1:** steady-load latency, throughput, connections, resource usage and saturation.
- **E2:** terminate a game pod and disconnect clients during active games; measure recovery, loss and duplicate/missing moves.
- **E3:** mixed correctness and privacy/rate-limit workloads, including abuse under legitimate load.
- **E4:** burst/idle/burst test across fixed and autoscaled configurations, including scale delay and cost.

The cost model includes compute, active-state storage, database, load balancer and network costs, normalized by successful completed matches and connection-minutes. The PRD also calls for raw traces, run manifests, plots and reproducible experiments.

## 8. Milestones, risks and priorities

- **M1:** two browsers complete a correct match without private-board leakage.
- **M2:** replay seeded bot traces across the compared configurations, including failure and metrics.
- **M3:** produce run manifests, raw data, plots, cost analysis and a reproducible experiment.

The original six-week schedule covered rules and client, complete gameplay, reconnect/idempotency, bots and metrics, autoscaling/experiments, then analysis and final documentation. Principal risks were WebSocket/bot complexity, shared-state races and insufficient capacity for the 2,000-connection target.

If the schedule slips, the proposal drops cosmetic animation, AI, rankings/spectators and then the autoscaled configuration before core server authority, architectural comparison, bot workload, failure testing, privacy/concurrency checks or the cost model.

## 9. Original references

The PDF cites RFC 6455, Kubernetes deployments and horizontal autoscaling documentation, Valkey, PostgreSQL, Grafana/k6/Prometheus and OpenTelemetry. Consult `CloudHack.pdf` for the complete original wording, diagrams, team information and references.
