# Hindsight — Wire & Agent Protocol (contract)

This is the binding contract between the **frontend**, the **backend/API**, and
the **agent layer**. Types live in `lib/types.ts`; this document defines the
byte-level formats those types map to. If you change anything here, update
`lib/types.ts` and every consumer.

---

## 1. Session storage

- One JSON file per session at `${HINDSIGHT_DATA_DIR}/sessions/<id>.json`, shape = `Session`.
  `Session.backtests` is the immutable successful-version history; every entry
  retains its exact result curve, strategy source, period, metrics, and lineage.
- Per-session agent working directory: `${HINDSIGHT_DATA_DIR}/work/<id>/`.
  - `params.json` — `{ "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "startingCapital": 10000 }`
  - `strategy.py` — the agent's generated backtest program (reused on re-runs)
  - `data/` — cached/snapshotted fetched data (deleted on a "refresh data" run)
  - `uploads/` — images attached to the opening prompt or a chat message. A
    **sibling** of `data/`, so a
    "refresh data" run never destroys them. Names are server-generated
    (`<nanoid>.<png|jpg|webp|gif>`); the client's filename is a label only.
  - `events.ndjson` — append-only progress stream written by the agent (see §3)
  - `result.json` — final result written by the agent (see §4)
  - `baseline/` — accepted `strategy.py` and `result.json` snapshots supplied
    during refinement so trial candidates can be compared and rolled back.
  - `versions/BT-###/` — materialized `strategy.py` and `result.json` for every
    version explicitly named in the current refinement.
  - `agent.log` — raw stdout/stderr of the agent process (debug only)
- **Persist results only.** On server boot, any session with `status: "running"`
  is rewritten to `status: "failed"` (we do not reattach to in-flight runs).

---

## 2. Run lifecycle (backend ↔ agent layer)

A "run" is one invocation of a backtest for a session. Kinds:

| Kind        | Trigger                                   | Agent involvement                                  |
|-------------|-------------------------------------------|----------------------------------------------------|
| `initial`   | `POST /api/sessions`                      | Full: write `strategy.py`, fetch data, backtest.   |
| `refine`    | `POST /api/sessions/[id]/messages`        | Edit existing `strategy.py` using the full conversation and accepted-result baseline, then re-run.|
| `rerun`     | `POST /api/sessions/[id]/rerun` (dates)   | **No LLM**: just re-execute `strategy.py` with new `params.json`. |
| `refresh`   | `rerun` with `refreshData: true`          | Delete `data/`, then behave like `rerun`.          |

The **AgentRunner** interface (agent layer) exposes:

```ts
interface AgentRunner {
  start(input: RunInput): RunHandle;   // begins a run; returns a handle
}
interface RunInput {
  session: Session;
  workDir: string;
  kind: 'initial' | 'refine' | 'rerun' | 'refresh';
  message?: string;                    // for 'refine'
  attachments?: Attachment[];          // images at <workDir>/uploads/<name>
  model?: string;                       // settings snapshot for LLM runs
  effort?: CodexEffort;                 // same snapshot, persisted on response
  onEvent: (e: ProgressEvent) => void; // runner emits parsed events here
}
interface RunHandle {
  interrupt(): Promise<void>;          // hard-kill (container `docker kill`, or process kill)
  done: Promise<StrategyResult>;       // resolves on success, rejects on failure/interrupt
}
```

The **run manager** (backend) owns one active `RunHandle` per session, buffers
emitted `ProgressEvent`s, fans them out to SSE subscribers, and on success
writes the `StrategyResult` into the session and flips `status` to `done`
(or `failed` on error/interrupt). Every success appends the next session-scoped
`BacktestVersion` (`BT-001`, `BT-002`, ...) and records which version it was
`basedOn`. The final successful agent `ChatMessage` receives
`metadata: { durationMs, model, effort, mode, backtestId }`. Model settings
are snapshotted at run start, so changing the app settings never changes the
provenance shown for an older response. `mode` is `codex`, `mock`, or
`saved-code` for new runs (`legacy` marks migrated metadata); non-LLM modes
accurately carry null model/effort values.

In a refinement, canonical `BT-###` tokens are resolved before the run starts.
The first named version is the primary starting point: its period/capital feed
`params.json`, and its exact strategy/result replace the active files and
`baseline/`. Every named version is also materialized under `versions/` for
comparison. Unknown ids return 400; a legacy snapshot without recoverable code
returns 409. Additional ids do not replace the primary unless the prompt says so.

---

## 3. Agent → runner progress: `events.ndjson`

The agent appends **one JSON object per line** as it works. Each line is an
`AgentEvent` (subset of `ProgressEvent`): `step | status | meta | message | log`.
The runner tails this file and forwards each parsed line via `onEvent`.

During an LLM-backed refinement, the strategy may be evaluated more than once.
The runner holds agent-role messages until completion and persists/streams only
the last one, so a trial candidate cannot become the displayed final summary.
System-role notes remain live.

Canonical sequence for an `initial` run (labels are examples):

```json
{"type":"status","label":"Tinkering…"}
{"type":"meta","name":"Inverse Cramer","description":"Fade every Cramer call, weekly rebalance"}
{"type":"step","id":"strategy","label":"Strategy written","state":"done"}
{"type":"status","label":"Sketching…"}
{"type":"step","id":"data","label":"Prices fetched, 2016–2025","state":"done"}
{"type":"status","label":"Crunching…"}
{"type":"step","id":"backtest","label":"Running the backtest","state":"active"}
```

Rules:
- `status.elapsedMs` is **optional from the agent** — the runner is authoritative
  on elapsed time and will stamp/override it. The agent only needs `label`.
- A `step` with an existing `id` and `state:"done"` supersedes the earlier
  `active` row of the same id.
- `meta` should be emitted once, as early as the agent can name the strategy.
- `message` with `role:"agent"` becomes a chat message (e.g. the summary line
  "Built it from Cramer's public calls…"). On successful completion the run
  manager adds the authoritative duration/model/effort metadata before it is
  persisted and streamed. `role:"system"` becomes a muted note.
- Lines that fail to parse are ignored by the runner (logged to `agent.log`).

---

## 4. Agent → runner result: `result.json`

On success the agent writes `result.json` and exits 0. Shape:

```json
{
  "name": "Inverse Cramer",
  "description": "Fade every Cramer call, weekly rebalance",
  "startingCapital": 10000,
  "finalValue": 30642.05,
  "returnPct": 206.4,
  "equityCurve": [["2016-01-04", 10000.0], ["2016-01-05", 10021.3], "..."],
  "positions": [["2016-01-04", {"SPY": 0.6, "TLT": 0.4}], ["2016-01-05", {"SPY": 1.0}], "..."],
  "benchmarkTicker": "SPY",
  "benchmarkReason": "SPY is the liquid broad-market proxy for this US large-cap strategy.",
  "benchmark": null,
  "code": "…the strategy.py source…",
  "period": { "start": "2016-01-01", "end": "2025-12-31" }
}
```

- `equityCurve` is an array of `[isoDate, value]` **tuples** (compact on disk).
  The runner converts to `EquityPoint[]` and validates ascending dates.
- `positions` is OPTIONAL: `[isoDate, {"TICKER": weight, ...}]` tuples — the
  target portfolio weights the strategy **holds** as of that bar's close, after
  acting on that bar's signals. Weights are fractions of portfolio value; cash
  is implied by a sum below 1; negative weights mean shorts. The runner converts
  to `PositionsPoint[]`: malformed entries are dropped, weights coerced to
  finite numbers under trimmed uppercase tickers, dates deduped (last entry
  wins), sorted ascending, capped to the ~750 most recent bars. Absent/invalid
  → the field is omitted (legacy results have none). Accepted positions round-
  trip through the restored `result.json` and `BacktestVersion` snapshots like
  every other result field.
- `finalValue` / `returnPct` are recomputed/validated by the runner from the
  curve if missing or inconsistent (`returnPct = (final/start - 1) * 100`).
- `benchmarkTicker` and `benchmarkReason` are reassessed by the agent for every
  initial/refinement result and embedded in `strategy.py` for no-model re-runs.
  The run manager validates the recommendation against the accepted code; if it
  is absent or invalid, it derives a fresh comparison from that exact version.
  `benchmark` remains an optional precomputed curve and is normally `null`.
- The runner stamps `ranAt` and `durationMs`.
- If the process exits non-zero or `result.json` is absent/invalid, the runner
  emits `{type:"error"}` and the run is `failed`; the error text is surfaced as
  an **agent chat message** in the expanded view.

---

## 5. Realism rules (baked into the container's AGENTS.md)

Every generated backtest MUST:
1. Use **split/dividend-adjusted** prices (total-return where the strategy holds).
2. Apply **transaction costs** (default 5 bps/trade) and **slippage** (default 5 bps).
3. Model **shorting** realistically: borrow availability + a borrow fee (default
   ~1%/yr; higher for hard-to-borrow), and mark short P&L correctly.
4. Avoid **lookahead**: signals at bar close act on the *next* bar; never use
   same-bar or future data.
5. Avoid **survivorship bias**: include delisted names where the strategy's
   universe implies them; note in the summary when data limits force an approximation.
6. Read `/work/params.json` for `{start, end, startingCapital}` so a date-only
   re-run needs no LLM. Cache fetched data under `/work/data/` and reuse it if
   present (that's the per-session snapshot); a `refresh` run starts with `data/` empty.

The agent's chat summary should be honest about assumptions and any data gaps.

---

## 6. HTTP API

All JSON. Errors: `{ "error": string }` with a 4xx/5xx status.

| Method | Path                              | Body                 | Returns              |
|--------|-----------------------------------|----------------------|----------------------|
| GET    | `/api/sessions`                   | —                    | `Session[]` (newest first) |
| POST   | `/api/sessions`                   | `CreateSessionBody` or multipart | `Session` (status `running`) |
| GET    | `/api/sessions/[id]`              | —                    | `Session`            |
| DELETE | `/api/sessions/[id]`              | —                    | `{ ok: true }`       |
| POST   | `/api/sessions/[id]/messages`     | `RefineBody` or multipart | `Session`       |
| GET    | `/api/sessions/[id]/attachments/[name]` | —              | image bytes          |
| POST   | `/api/sessions/[id]/rerun`        | `RerunBody`          | `Session`            |
| POST   | `/api/sessions/[id]/interrupt`    | —                    | `{ ok: true }`       |
| GET    | `/api/sessions/[id]/benchmark`    | — (`?ticker=` opt.)  | `BenchmarkResponse`  |
| GET    | `/api/sessions/[id]/stream`       | — (SSE)              | `text/event-stream`  |
| GET    | `/api/health`                     | —                    | `AgentHealth`        |
| GET    | `/api/settings`                   | —                    | `AppSettings`        |
| PUT    | `/api/settings`                   | `UpdateSettingsBody` | `AppSettings`        |
| POST   | `/api/sessions/[id]/share`        | —                    | `ShareInfo`          |
| DELETE | `/api/sessions/[id]/share`        | —                    | `{ ok: true }`       |
| GET    | `/share/[token]`                  | —                    | self-contained HTML  |
| POST   | `/api/sessions/[id]/activate`     | `ActivateBody`       | `Session`            |
| DELETE | `/api/sessions/[id]/activate`     | —                    | `Session`            |
| POST   | `/api/sessions/[id]/activate/check` | —                  | `SignalCheckResponse` |
| GET    | `/api/signals`                    | —                    | `SignalsOverview`    |

Periods are validated where they enter: `POST /api/sessions` and
`POST …/rerun` return **400** for a side that isn't `YYYY-MM-DD` or a window
whose start is after its end.

`GET /api/health` reports whether the selected agent can run at all. In
`HINDSIGHT_AGENT=codex` mode that means host Codex credentials — a readable
`$HINDSIGHT_CODEX_HOME/auth.json` carrying an `OPENAI_API_KEY` or
`tokens.access_token` (the container copies exactly that file, see
`docker/entrypoint.sh`). `mock` mode is always ready. When `ready` is false the
empty-state composer is disabled and shows `reason` + `hint`, and the two
LLM-backed endpoints (`POST /api/sessions`, `POST …/messages`) refuse with
**503** so a stale tab can't start a run that would only fail inside Docker.
`rerun`/`refresh` are unaffected — they re-execute saved code with no LLM.

`/api/settings` holds the app-wide model + reasoning effort for LLM-backed runs
(the header's settings dialog). Persisted at `${data}/settings.json` (atomic
tmp-file + rename, like sessions). The run manager snapshots it at run start and
the CodexRunner passes `HS_MODEL` / `HS_EFFORT` to the container; the entrypoint forwards them
as `codex exec -m <model> -c model_reasoning_effort=<effort>`. With no settings
file, the model defaults to `HINDSIGHT_CODEX_MODEL` (else `gpt-5.6-sol`) and
the effort to `medium`. PUT accepts a partial body but only the values in
`CODEX_MODELS` / `CODEX_EFFORTS` (400 otherwise); `rerun`/`refresh` never use
either (no LLM). The mock runner ignores settings entirely.

In the expanded chat, successful-run metadata is visually attached beneath its
agent response and revealed only while that response is hovered. Its `BT-###`
control copies the id for pasting into a later refinement. Legacy session files
that stored `Backtest finished in …` as a separate system message are folded
into the same hover treatment; their unknown historical model/effort are shown
as unavailable rather than inferred from today's settings. Because earlier
strategy sources were never archived, migration versions only the currently
recoverable result and preserves its original completion ordinal (for example,
a four-run legacy session exposes its current state as `BT-004`).

### Sharing (tunnel-safe read-only pages)

`POST …/share` does the whole job: mints an unguessable token (idempotent;
stored on the session as `shareToken`), STARTS a cloudflared quick tunnel
(`lib/server/tunnel.ts` — one per server process, reused across shares, state
on globalThis so dev reloads don't orphan it), and returns the finished public
link (`ShareInfo.url`). When `cloudflared` isn't installed it returns
`url: null` + `cloudflaredInstalled: false` and the popover says to install it;
a tunnel that fails to start is a 502. `GET /share/[token]` serves the strategy
as ONE self-contained HTML document (inline CSS, server-rendered SVG chart, no
JS, no `/_next` assets, no API calls). `DELETE …/share` revokes the token and
closes the tunnel when no shared strategies remain (a revoked token 404s even
while the tunnel drains).

The safety layer is `proxy.ts` (root): a request is tunnel traffic when
any IP in its forwarding headers (`X-Forwarded-For` / `Cf-Connecting-Ip` /
`X-Real-Ip`) is public, or `Cf-Ray` is present. (Presence alone can't be the
signal — Next's dev server stamps `X-Forwarded-For: ::1` on local requests.
The daemon appends the visitor's real public IP and a visitor can't remove it,
so the check fails closed.) Tunnel traffic may reach ONLY `/share/<token>`;
every other path 404s. Local and LAN (private-IP) requests are untouched. Each
tunnel request — allowed or denied — is logged to the server terminal with the
visitor's IP. (`proxy.ts` is the Next 16+ name for this file convention; on
Next 14/15 it was `middleware.ts`.)

Create / refine / rerun all **start a run** and return immediately with the
(updated) session at `status: "running"`; the client then opens the SSE stream.

### Image attachments

Both composers take images, so both endpoints accept either `application/json`
or `multipart/form-data`:

| Endpoint | Multipart fields | Text required? |
|----------|------------------|----------------|
| `POST /api/sessions` | `prompt`, optional `start`/`end`/`startingCapital`, one `image` part per file | **Yes** — a new strategy needs words; an image alone can't say what period to test |
| `POST …/messages` | `text`, one `image` part per file | No — a chart on its own is a valid refinement |

`POST /api/sessions` validates images **before** creating the session (names are
assigned during validation, so the first chat message can record them), then
writes the bytes once the workdir exists. A rejected batch leaves no session and
no files; a write that fails after creation deletes the session rather than leave
one with broken attachments.

Server-side rules (`lib/server/uploads.ts`): at most 4 images per message, 10 MB
each, and only `image/png|jpeg|webp|gif`. The declared MIME type must match the
file's magic bytes — a browser Content-Type is only a claim, and SVG is refused
outright (it is script-bearing). A batch is validated in full before anything is
written, so a rejected message leaves no files behind.

Accepted files land in `uploads/` and are recorded on the user's `ChatMessage`
as `Attachment[]`. The run manager forwards them to the runner as
`RunInput.attachments`; the CodexRunner passes `HS_IMAGES` (newline-separated
`/work/uploads/*` paths) to the container, and the entrypoint turns each into a
`codex exec -i <path>` argument, so the model actually sees the images. Missing
paths are skipped with a warning rather than failing the run. The mock runner
ignores attachments (they still upload, persist, and render).

`GET …/benchmark` starts **no run**: it revalidates the chosen comparable and
fetches daily adjusted closes from Yahoo's public chart endpoint, returning a
buy-and-hold curve scaled to the selected result's starting capital. By default
it targets the latest accepted response; `?backtestId=BT-###` targets that exact
archived response. The result's agent recommendation is accepted only when its
rationale and relationship to the actual strategy pass server checks; otherwise
the server derives a fresh proxy from that version's code/meta. `?ticker=` is an
explicit override. Missing or incomplete inferred price coverage falls back to
`SPY`; an invalid explicit override 502s. Price curves are cached in-process for
6h, while benchmark selection is revalidated on every request.

---

## 7. SSE stream: `GET /api/sessions/[id]/stream`

`Content-Type: text/event-stream`. First frame is always a snapshot:

```
event: snapshot
data: {"sessionId":"…","status":"running","steps":[…],"status_line":{"label":"Crunching…","elapsedMs":23000},"active":true}

```

Then one frame per `ProgressEvent`, the `event:` field being its `type`:

```
event: status
data: {"type":"status","label":"Crunching…","elapsedMs":24600}

event: step
data: {"type":"step","id":"backtest","label":"Running the backtest","state":"done"}

event: result
data: {"type":"result","result":{…StrategyResult…}}

event: done
data: {"type":"done"}
```

- The runner sends a `status` frame roughly every second while running so the
  Working view's elapsed timer stays live (`elapsedMs` is runner-authoritative).
- After `done` (or `error`) the server may keep the stream open idle or close it;
  the client treats `done`/`error` as terminal for that run and refetches the session.
- Heartbeat: a `: ping` comment line every ~15s to keep proxies from timing out.

---

## 8. Strategy activation & scheduled signals

Activating a strategy starts scheduled, **no-LLM** signal checks: the saved
strategy code is re-executed through today and the latest bar's target weights
(the `positions` series, §4) are diffed against the previous bar's. State lives
on the session as `activation: StrategyActivation | null` — `phone` (E.164),
`activatedAt`, `cadence`, `cadenceReason`, `nextCheckAt`, `lastCheckAt`,
`lastSignal`, `lastError`; absent/null means inactive, and the field is
hydrated defensively on read like `backtests`.

1. **Routes.** `POST /api/sessions/[id]/activate` (body `ActivateBody`,
   `{ phone?: string }` — E.164 after stripping spaces/dashes, falling back to
   `HINDSIGHT_SIGNAL_PHONE`; 400 when neither is valid) activates and returns
   the updated `Session`. It requires a successful result (400 otherwise) and
   no live run (409 — a run's heartbeat owns the session file). Re-activating
   updates the phone and re-derives the cadence; the confirmation message is
   re-sent only when the phone changed. `DELETE` deactivates and returns the
   `Session` (200 with no message when it was already inactive; 409 while a
   run is live). `POST …/activate/check` runs one check immediately on the
   scheduler's serial queue and returns `SignalCheckResponse`
   (`{ ok: true, update: SignalUpdate | null }`, null = no new bar); unlike a
   scheduled check it always sends the resulting message, HOLD included, and
   surfaces failures as 500 (busy/raced conflicts as 409). `GET /api/signals`
   returns `SignalsOverview` — the default phone, the configured provider, and
   every activated strategy — and boots the scheduler as a fallback for
   processes where `instrumentation.ts` did not run.
2. **Cadence** is derived from the strategy itself
   (`lib/server/signals/cadence.ts`): the asset class from the saved code's
   tickers, the latest reported positions, and prompt/description wording
   (crypto trades 24/7; US equities follow the NYSE clock), and the rebalance
   frequency from prompt + description + code text
   (`hourly | daily | weekly | monthly`, default daily). `cadenceReason` is
   the human explanation shown in the UI and in messages.
3. **Scheduler** (`lib/server/signals/scheduler.ts`, a globalThis singleton
   booted from `instrumentation.ts`): one timer armed at the earliest
   `nextCheckAt`, checks strictly one at a time; a session with a live backtest
   run is skipped and retried ~2 min later. Each check re-runs the accepted
   code in a **scratch workdir** at `${data}/signals/<id>/` (`HS_KIND=rerun`
   container with `data/` emptied every check for fresh bars, hard 5-minute
   deadline then `docker kill`; the mock agent regenerates in-process). The
   real `work/<id>/` dir, versions, chat, and `dataSnapshotAt` are never
   touched by a check.
4. **Messaging policy.** A message is sent when positions changed, on the first
   successful check (holdings confirmation), and once when checks start
   failing (the null→error transition); scheduled HOLDs and no-new-bar checks
   are silent. Activation and deactivation always send a confirmation.
   Delivery (`HINDSIGHT_SIGNAL_PROVIDER`): `imessage` (default — Messages.app
   via `osascript` on the macOS host; note it sends **as the signed-in Apple
   ID**, so messages to your own number land in the self-thread without
   notifications), `signal` (recommended — a self-hosted
   [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)
   service, shareable across projects: Hindsight POSTs
   `{ number, recipients, message }` to `HINDSIGHT_SIGNAL_CLI_URL` `/v2/send`,
   sending from the dedicated bot number `HINDSIGHT_SIGNAL_SENDER`, with
   `HINDSIGHT_SIGNAL_CLI_AUTH` forwarded as the `Authorization` header when
   set; run the service in `json-rpc` mode so it receives continuously —
   register the bot number once on that host), `poke` (Poke.com inbound
   webhook with `HINDSIGHT_POKE_API_KEY`), or `webhook` (`{ phone, message }`
   POSTed to `HINDSIGHT_SIGNAL_WEBHOOK_URL`). Every message that goes out is
   also appended to the session chat as a `system` message. The share page
   never exposes `activation` — it carries the phone number.
