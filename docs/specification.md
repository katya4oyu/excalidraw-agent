# Excalidraw Agent Specification

この文書は、現在のコードベースから読み取れる Excalidraw Agent の実装仕様をまとめる。目標設計ではなく、実装済みの振る舞いを正とする。

## 1. Product Scope

Excalidraw Agent は、人間と Agent が同じ Yjs document 上で Excalidraw canvas を共同編集するためのローカル実験アプリケーションである。

主な機能は次の通り。

- ブラウザで Excalidraw canvas を作成、編集、共同同期する。
- canvas ごとに `fileId` と Hocuspocus document name を割り当てる。
- `.excalidraw` ファイルを import して Yjs document に復元する。
- `.excalidraw` export 時に Excalidraw Agent 用 metadata を埋め込む。
- footer の Run button、auto mode、または legacy instruction text element から Agent run request を作る。
- server が file ごとの worker process を管理し、queued request を worker へ渡す。
- worker が Codex SDK を使って Excalidraw scene artifact を作成する。
- worker が最終 artifact から add-only proposal を導出し、ghost element として Yjs へ publish する。
- 人間が最新 proposal を approve/reject できる。

現在の proposal apply は add operation を中心に実装されている。既存要素の update、delete、move は patch として検出されるが、approve 時は unsupported/conflict 扱いになる。

## 2. Workspace Components

```text
apps/web
  React + Vite + Excalidraw UI

apps/server
  Hono REST API
  Hocuspocus WebSocket collaboration server
  SQLite persistence
  Agent worker supervisor

apps/worker
  Per-file worker process
  Codex SDK runtime wrapper
  Proposal pipeline

packages/shared
  Shared types, IDs, metadata, Excalidraw helper element constructors

packages/y-excalidraw-core
  Canonical Yjs element helpers and proposal apply/reject logic

packages/y-excalidraw-browser
  Browser-facing binding exports and agent footer observer

packages/y-excalidraw-agent
  Headless agent proposal publish helpers
```

Dependency direction:

```text
web -> shared, y-excalidraw-browser
server -> shared
worker -> shared, y-excalidraw-agent
y-excalidraw-browser -> y-excalidraw-core
y-excalidraw-agent -> y-excalidraw-core
y-excalidraw-core -> yjs
```

## 3. Runtime Configuration

Default local endpoints:

```text
server http://127.0.0.1:8787
web    http://127.0.0.1:5173
ws     ws://127.0.0.1:8787/collab
```

Server environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Hono server port |
| `HOST` | `127.0.0.1` | Hono server host |
| `PUBLIC_BASE_URL` | `http://{HOST}:{PORT}` | URL passed to worker |
| `DATABASE_URL` | `apps/server/data/excalidraw-agent.sqlite` | SQLite path or `:memory:` |

Worker defaults:

| Setting | Default |
| --- | --- |
| workspace root | `~/.excalidraw-agent` |
| workspace per file | `~/.excalidraw-agent/{fileId}` |
| template | `apps/worker/templates/codex/` |
| runtime model | `gpt-5.3-codex-spark` |
| server URL | `http://127.0.0.1:8787` |

`EXCALIDRAW_AGENT_PREPARE_ONLY=true` makes the worker prepare the workspace without starting Codex or connecting to collaboration.

## 4. HTTP and WebSocket API

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `GET /api/codex/status`

Returns Codex availability.

```ts
type CodexAvailability = "available" | "not_logged_in" | "error";
type CodexAuthMethod = "chatgpt" | "api_key" | "access_token" | "unknown" | null;
```

### `POST /api/files`

Creates a new file metadata row.

Behavior:

1. Generate `fileId` with `crypto.randomUUID()`.
2. Create document name as `file:{fileId}`.
3. Insert file row with `agentStatus: "idle"`.
4. Return `201`.

Response:

```json
{ "id": "..." }
```

The worker is not started by this endpoint directly. It is started when a browser connects to the collaboration document or when an agent run is requested.

### `POST /api/files/import`

Imports a local `.excalidraw` JSON document into a Yjs document.

Request:

```ts
{
  fileId?: string;
  document: ExcalidrawDocumentData;
}
```

File ID resolution:

1. Use explicit `fileId` if present and non-empty.
2. Otherwise use `document.excalidrawAgent.fileId` if valid.
3. Otherwise create a new ID.

If the resolved file already exists in SQLite, the endpoint returns that file and does not import over existing Yjs state.

If a new file is created:

- `files` row is created with `agentStatus: "verified"`.
- `document.elements` are inserted into `Y.Array("elements")`.
- `document.files` are copied into `Y.Map("assets")`.
- `document.appState` entries are copied into `Y.Map("appState")`.
- element positions are normalized if invalid or duplicated.
- encoded Yjs state is stored in SQLite.

Response:

```ts
{
  id: string;
  documentName: `file:${string}`;
  created: boolean;
  imported: boolean;
}
```

### `GET /api/files/:id`

Returns file metadata or `404`.

```ts
{
  id: string;
  documentName: `file:${string}`;
  createdAt: string;
  updatedAt: string;
  agentStatus: "idle" | "starting" | "running" | "verified" | "failed";
}
```

### `POST /api/files/:id/agent-runs`

Queues an API-originated Agent run.

Request:

```json
{ "prompt": "..." }
```

Behavior:

1. Validate file exists.
2. Validate prompt is non-empty.
3. Ensure the file worker exists.
4. Open a direct Hocuspocus connection to the document.
5. Write a queued request to `Y.Map("agentRunRequests")`.
6. Return `202`.

Response:

```ts
{
  fileId: string;
  requestId: string;
  agentStatus: "queued";
}
```

### `WS /collab`

Hocuspocus WebSocket endpoint. Document names use:

```text
file:{fileId}
```

Connections whose request parameters include `source=worker` are ignored for human connection counts. The current worker provider does not set that parameter in `connectFileDocument`, so this is a supported server-side distinction rather than a fully wired worker behavior.

## 5. Persistence

SQLite schema:

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  document_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agent_status TEXT NOT NULL
);

CREATE TABLE yjs_documents (
  document_name TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
```

The database uses WAL mode and foreign keys are enabled. Yjs document state is persisted as `Y.encodeStateAsUpdate(document)`.

## 6. Yjs Document Schema

Top-level stores used by the implementation:

| Store | Type | Purpose |
| --- | --- | --- |
| `elements` | `Y.Array<Y.Map>` | Excalidraw elements, each item has `el` and `pos` |
| `assets` | `Y.Map` | Excalidraw binary file records |
| `appState` | `Y.Map` | Imported app state applied after browser sync |
| `agentSettings` | `Y.Map` | Auto mode settings |
| `agentRunRequests` | `Y.Map` | Current canonical run requests |
| `agentInstructionRequests` | `Y.Map` | Legacy mirror for older instruction-note flow |
| `agentRuns` | `Y.Map` | Run status and worker progress metadata |
| `agentProposals` | `Y.Map` | Proposal status and ghost element IDs |
| `notes` | `Y.Map` | Embedded Note content |
| `agentInstructionNotes` | `Y.Map` | Legacy note store read for compatibility |

### Element Storage

Each Excalidraw element is wrapped:

```ts
{
  el: Record<string, unknown>;
  pos: string;
}
```

`pos` is a fractional-indexing key. If an element has a valid Excalidraw `index`, that value may be used as `pos`; otherwise a new fractional key is generated. `normalizeExcalidrawElementPositions` rewrites invalid or duplicate `pos` values.

### File Metadata Embedded in Exported Documents

```ts
{
  excalidrawAgent: {
    schemaVersion: 1;
    fileId: string;
    documentName: `file:${string}`;
    serverBaseUrl?: string;
    sidecarFile?: string;
    updatedAt: string;
  }
}
```

Import uses this metadata to reconnect a local `.excalidraw` file to its existing collaboration document when possible.

## 7. Browser Specification

`apps/web` starts at `/`, creates a file through `POST /api/files`, and redirects to `/files/{fileId}`.

The file page owns:

- Excalidraw rendering.
- Hocuspocus provider lifecycle.
- Yjs/Excalidraw binding setup through `@mizuka-wu/y-excalidraw`.
- collaboration status display.
- worker/Codex status polling.
- Note placement and embedded Note iframe rendering.
- manual run button.
- auto mode toggle.
- latest proposal approve/reject buttons.
- Agent presence overlay.
- image file insertion fallback.

### Collaboration Setup

Browser clients create a `HocuspocusProvider` with:

```ts
url: VITE_COLLAB_URL ?? `${window protocol}//${window host}/collab`
name: `file:${fileId}`
```

Awareness local user state:

```ts
{
  name: "Human",
  color: "#246b5b",
  role: "human"
}
```

On provider sync, imported `appState` is applied to Excalidraw if present.

### Notes

The current Note implementation uses Excalidraw `embeddable` elements with metadata. Notes are stored as canvas context and can be read by the worker through the run snapshot; editing a Note does not by itself enqueue a run request in the current browser code.

```ts
{
  customData: {
    excalidrawAgent: {
      schemaVersion: 1;
      kind: "note-embed";
      fileId: string;
      noteId: string;
      text?: string;
    }
  }
}
```

Note content is stored in `Y.Map("notes")`:

```ts
{
  schemaVersion: 1;
  fileId: string;
  noteId: string;
  text: string;
  status: "idle" | "queued" | "running" | "proposed" | "conflicted" | "failed";
  requestId?: string;
  runId?: string;
  createdAt: number;
  updatedAt: number;
}
```

The embedded iframe communicates with the parent by `postMessage`. The parent accepts messages only from the same origin.

### Instruction Requests

Two instruction mechanisms exist:

- legacy text elements with `customData.excalidrawAgent.kind === "instruction"`;
- current embeddable Note elements backed by `notes`.

When a legacy instruction text element contains a non-placeholder prompt, browser `onChange` writes a queued request to both `agentRunRequests` and `agentInstructionRequests`.

For note-based requests written by another producer, server-side request validation can read the prompt from `notes`, legacy `agentInstructionNotes`, or the note embed metadata.

### Auto Mode

Default agent settings:

```ts
{
  schemaVersion: 1,
  autoModeEnabled: false,
  autoIdleMs: 30000,
  updatedAt: number
}
```

When auto mode is enabled, the browser watches human scene signatures. After `autoIdleMs` with no active run and no pending proposal, it creates an `auto-idle` request in `agentRunRequests`.

The auto prompt asks for one small add-oriented improvement, or no change if unnecessary.

### Proposal Review

The browser observes `agentRuns`, `agentProposals`, and `elements` to derive footer state:

```ts
{
  runStatus:
    | "idle"
    | "queued"
    | "running"
    | "proposed"
    | "applying"
    | "applied"
    | "rejected"
    | "failed"
    | "conflicted";
  activeRunCount: number;
  proposedCount: number;
  ghostElementCount: number;
}
```

Approve/reject operate on the latest proposal whose status is `"proposed"`.

## 8. Server Specification

### Collaboration Lifecycle

On browser connect:

1. Resolve `fileId` from `documentName`.
2. Increment human connection count.
3. Cancel any scheduled idle worker stop.
4. Ensure a worker exists for the file.

On browser disconnect:

1. Decrement connection count.
2. If no human clients remain, schedule worker stop after the supervisor grace period.

On document load:

1. Load persisted state from SQLite if available.
2. Apply update to a new Y.Doc.
3. Normalize element positions.
4. Check queued Agent requests.

On document change:

1. Check queued Agent requests.
2. If no Agent run is active, mark file `agentStatus` as `"verified"`.

### Agent Request Dispatch

`startAgentFromInstructionRequests` reads candidates from:

1. `agentRunRequests`;
2. `agentInstructionRequests`, normalized to the current schema when possible.

Only requests with `status: "queued"` and a non-empty prompt are eligible.

For instruction-note requests, the server verifies that the current prompt still matches the source element or note. If it no longer matches, the request is marked `"stale"`.

If a run is already active, no new request is dispatched.

When a request is dispatched:

- a fresh `runId` is generated as `agent-run-{uuid}`;
- the request is enqueued into the supervisor;
- the request is marked `"running"`;
- an `agentRuns[runId]` entry is created.

### Worker Supervisor

The supervisor forks one worker process per file as needed.

Worker command shape:

```text
node --import tsx apps/worker/src/index.ts \
  --daemon \
  --file-id {fileId} \
  --server-url {PUBLIC_BASE_URL}
```

The child process uses IPC messages.

Parent to worker:

```ts
{ type: "runQueued"; fileId: string; request: AgentRunQueueRequest }
{ type: "shutdown"; reason?: string }
```

Worker to parent:

```ts
{ type: "ready"; fileId: string }
{ type: "runStarted"; fileId: string; runId: string }
{ type: "runFinished"; fileId: string; runId: string; status: "proposed" | "conflicted" | "failed" }
{ type: "workerFailed"; fileId: string; error: string; runId?: string }
```

The supervisor marks file `agentStatus` as:

- `"starting"` when a worker is forked;
- `"idle"` when worker is ready and not busy;
- `"running"` when a run starts;
- `"verified"` when a run finishes successfully;
- `"failed"` when worker failure is reported or the child exits unexpectedly.

## 9. Worker and Proposal Pipeline

The daemon worker does this for each queued request:

1. Prepare file workspace.
2. Connect to the Yjs document through Hocuspocus.
3. Create/update `agentRuns[runId]`.
4. Write a base snapshot under `runs/{runId}/base-scene.json`.
5. Ask Codex for `estimate.json`.
6. Resolve a collision-avoiding planned area.
7. Publish Agent awareness/presence for the planned area.
8. For each estimate step, ask Codex for `draft-step-{n}.excalidraw`.
9. Publish draft ghost elements for visible draft progress.
10. Ask Codex for `final.excalidraw`.
11. Assess final artifact quality.
12. If quality fails, ask Codex for one refinement.
13. Derive patch from base snapshot and final scene.
14. Remove draft ghosts.
15. Publish final ghost proposal.
16. Mark request `"proposed"` or `"failed"`.

Run artifacts:

```text
runs/{runId}/
  base-scene.json
  estimate.json
  draft-step-1.excalidraw
  draft-step-2.excalidraw
  final.excalidraw
  derived.patch.json
  human-deltas.jsonl
  quality-report.json
```

### Base Revision

`createBaseRevisionSnapshot` computes a stable `scene:{hash}` from visible elements, assets, and notes. It excludes transient element state such as selection/editing/dragging.

### Planned Area

Codex estimates desired bounds. The worker clamps the size:

```text
width  240..960
height 180..720
```

If the preferred area collides with existing human elements, the worker tries locations to the right, below, left, and above existing bounds.

### Human Delta

Before and after every Codex turn, the worker captures visible non-agent elements and notes. If the signature changes, it appends a summary to `human-deltas.jsonl` and includes recent deltas in later prompts.

### Patch Derivation

The current patch derivation compares visible non-agent elements by ID:

- final element absent from base -> `add`;
- same ID with changed `x` or `y` -> unsupported `move`;
- same ID with other structural changes -> unsupported `update`;
- base element absent from final -> unsupported `delete`.

Add operations may be translated into the planned area if their bounds do not overlap it.

### Quality Gate

Final proposal passes only when:

- `final.excalidraw` exists and is readable;
- it yields at least one visible add element;
- proposed elements overlap the planned area.

After one failed quality check, the worker gives Codex one refinement turn. A second failure marks the run failed.

## 10. Proposal Model

Ghost element metadata:

```ts
{
  schemaVersion: 1;
  kind: "ghost";
  runId: string;
  proposalId: string;
  operation: "add" | "update" | "delete" | "move";
  targetElementId?: string;
  finalElementId?: string;
  baseRevision?: string;
  baseElementSnapshot?: {
    id: string;
    version?: number;
    versionNonce?: number;
    updated?: number;
    isDeleted?: boolean;
    snapshot?: Record<string, unknown>;
  };
  originalStyle?: Record<string, unknown>;
  createdAt: number;
}
```

Ghost elements are normal Excalidraw elements with modified visual style:

- `opacity` lowered;
- `locked: true`;
- `id` prefixed with `ghost:{runId}:`.

### Publish Proposal

`publishGhostProposal` appends ghost elements and writes:

```ts
agentRuns[runId].status = "proposed"

agentProposals[proposalId] = {
  status: "proposed",
  runId,
  proposalId,
  ghostElementIds,
  baseRevision,
  baseElementSnapshots,
  source,
  createdAt
}
```

### Approve

Approval succeeds only when:

- proposal exists and has `status: "proposed"`;
- proposal has ghost elements;
- all ghost operations are `"add"`;
- base snapshots are not stale;
- no live element already exists with the final element ID.

On success, each ghost is materialized:

- ghost prefix is removed or `finalElementId` is used;
- original style is restored;
- `opacity` becomes `100`;
- `locked` becomes `false`;
- Agent custom metadata is removed;
- version fields are bumped.

The proposal status becomes `"approved"` and run status becomes `"applied"`.

### Reject

Reject marks proposal ghosts as deleted, sets proposal status to `"rejected"`, and sets run status to `"rejected"`.

### Conflict and Stale

Unsupported operations mark the proposal/run conflicted. Stale base element snapshots mark the proposal `"stale"` and run `"conflicted"`.

## 11. Known Limitations

- Proposal apply supports add-only materialization. Update/delete/move are detected but not safely applied.
- Model selection in the web footer is UI-only; worker currently uses `gpt-5.3-codex-spark`.
- The worker requires Codex SDK/CLI authentication in the local environment.
- The server persistence model stores full encoded Yjs updates, not an event log.
- There is no multi-worker parallel execution for the same file; active or pending runs block new dispatch.
- Conflict handling is conservative and mostly fails closed.
- `agentInstructionRequests` and `agentInstructionNotes` remain as legacy compatibility stores.
- Codex-generated artifacts are trusted after structural quality checks; there is no rendered visual QA in this worker pipeline yet.
