# Hindsight — Wire & Agent Protocol (contract)

This is the binding contract between the **frontend**, the **backend/API**, and
the **agent layer**. Types live in `lib/types.ts`; this document defines the
byte-level formats those types map to. If you change anything here, update
`lib/types.ts` and every consumer.

---

## 1. Session storage

- One JSON file per session at `${HINDSIGHT_DATA_DIR}/sessions/<id>.json`, shape = `Session`.
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
  - `agent.log` — raw stdout/stderr of the agent process (debug only)
- **Persist results only.** On server boot, any session with `status: "running"`
  is rewritten to `status: "failed"` (we do not reattach to in-flight runs).

---

## 2. Run lifecycle (backend ↔ agent layer)

A "run" is one invocation of a backtest for a session. Kinds:

| Kind        | Trigger                                   | Agent involvement                                  |
|-------------|-------------------------------------------|----------------------------------------------------|
| `initial`   | `POST /api/sessions`                      | Full: write `strategy.py`, fetch data, backtest.   |
| `refine`    | `POST /api/sessions/[id]/messages`        | Edit existing `strategy.py` per the message, re-run.|
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
(or `failed` on error/interrupt).

---

## 3. Agent → runner progress: `events.ndjson`

The agent appends **one JSON object per line** as it works. Each line is an
`AgentEvent` (subset of `ProgressEvent`): `step | status | meta | message | log`.
The runner tails this file and forwards each parsed line via `onEvent`.

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
  "Built it from Cramer's public calls…"). `role:"system"` becomes a muted note.
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
  "benchmark": null,
  "code": "…the strategy.py source…",
  "period": { "start": "2016-01-01", "end": "2025-12-31" }
}
```

- `equityCurve` is an array of `[isoDate, value]` **tuples** (compact on disk).
  The runner converts to `EquityPoint[]` and validates ascending dates.
- `finalValue` / `returnPct` are recomputed/validated by the runner from the
  curve if missing or inconsistent (`returnPct = (final/start - 1) * 100`).
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
tmp-file + rename, like sessions). The CodexRunner reads it at run start and
passes `HS_MODEL` / `HS_EFFORT` to the container; the entrypoint forwards them
as `codex exec -m <model> -c model_reasoning_effort=<effort>`. With no settings
file, the model defaults to `HINDSIGHT_CODEX_MODEL` (else `gpt-5.6-sol`) and
the effort to `medium`. PUT accepts a partial body but only the values in
`CODEX_MODELS` / `CODEX_EFFORTS` (400 otherwise); `rerun`/`refresh` never use
either (no LLM). The mock runner ignores settings entirely.

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

`GET …/benchmark` starts **no run**: it fetches daily adjusted closes for a
comparable equity from Yahoo's public chart endpoint and returns a buy-and-hold
curve over the session's period, scaled to its starting capital (the chart's
Compare toggle). The symbol is inferred from the strategy — an all-caps token in
the name/prompt that isn't indicator jargon, else `SPY`; `?ticker=` overrides it.
An inferred symbol that no longer resolves falls back to `SPY`, while an
explicitly requested one 502s. Curves are cached in-process for 6h.

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
