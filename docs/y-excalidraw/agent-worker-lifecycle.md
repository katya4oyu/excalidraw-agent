# Agent worker lifecycle design

## Goal

WebUIで `/files/:id` を開いた時点で、その `fileId` に対応する常駐Agent Workerを生成または再利用する。Workerは起動直後にCodex runを開始せず、明示的な指示がYjsまたはREST APIからqueueされるまでidleで待機する。

この設計の目的は以下である。

- fileIdごとに1つのWorker processと1つのCodex threadを維持する。
- WebUIを開くだけでは作業を始めず、ユーザー指示だけを実行契機にする。
- 同一fileIdではrunを1件ずつ処理し、追加指示はqueueに残す。
- serverがWorker processの生成、IPC、状態更新を一元管理する。

## Components

```text
apps/web
  FilePage
    -> HocuspocusProvider(file:{fileId})
    -> agentInstructionRequestsへqueued requestを書き込む

apps/server
  Hono REST API
    -> POST /api/files
    -> POST /api/files/:id/agent-runs

  Hocuspocus collab server
    -> onLoadDocument
    -> onChange
    -> queued instruction requestをclaim

  AgentSupervisor
    -> fileIdごとのworker process管理
    -> IPC送受信
    -> run queue管理
    -> persisted Yjs metadata更新

apps/worker
  --daemon mode
    -> workspace準備
    -> Codex thread生成
    -> runQueued/shutdownを待つ
```

## Worker lifetime

Worker lifetimeはfileId単位とする。

- `fileId`ごとに最大1つのworker processを持つ。
- 同じdocumentへ再接続した場合、既存workerを再利用する。
- Workerは起動後にworkspaceを準備し、準備完了後にIPCで`ready`を返す。
- Workerがidleでも、明示的に停止されるまではprocessを維持する。
- `stopIdleWorker(fileId)`は、workerがbusyでなくpending queueも空の場合だけ停止できる。

server側の公開interface:

```ts
interface WorkerHandle {
  fileId: FileId;
  ready: boolean;
  busy: boolean;
}

class AgentSupervisor {
  ensureWorker(fileId: FileId): WorkerHandle;
  enqueueRun(fileId: FileId, request: AgentRunQueueRequest): boolean;
  isWorkerReady(fileId: FileId): boolean;
  isRunActive(fileId: FileId): boolean;
  stopIdleWorker(fileId: FileId, reason?: string): boolean;
}
```

## Spawn timing

Worker生成タイミングはWebUIのdocument接続時である。

1. UserがWebUIで `/files/:id` を開く。
2. `FilePage` が `HocuspocusProvider` で `file:{id}` に接続する。
3. serverの`onLoadDocument`がpersisted Yjs stateを読み込む。
4. `startAgentFromInstructionRequests(document, fileId, agents)` が呼ばれる。
5. その冒頭で `agents.ensureWorker(fileId)` を呼び、workerを生成または再利用する。

`POST /api/files` はworkerを起動しない。新規ファイルを作るだけで、`agentStatus` は初期状態として `idle` になる。

Importされた既存ファイルも同様に、WebUIで開いてHocuspocus documentがloadされた時点でworkerを確保する。Import API単体ではworkerを起動しない。

## Execution triggers

Codex runの開始契機は明示指示のみとする。

### Instruction note

WebUIで置き手紙が編集されると、`useExcalidrawCollab` がYjsへrequestを書き込む。

```text
agentInstructionRequests[requestId] = {
  status: "queued",
  source: "instruction-note",
  prompt,
  elementId,
  createdAt,
  updatedAt
}
```

serverの`onChange`はqueued requestを探し、以下を満たす場合だけclaimする。

- workerが既にactive runを持っていない。
- request statusが`queued`である。
- `source`が`instruction-note`である。
- requestの`prompt`が、現在のinstruction text elementから再抽出したpromptと一致する。

promptが一致しない場合、そのrequestは`stale`へ遷移する。

### REST API

`POST /api/files/:id/agent-runs` は、空でない`prompt`を受け取った場合にAPI由来のrunを作る。

```text
agentInstructionRequests[requestId] = {
  status: "running",
  source: "api",
  prompt,
  runId,
  createdAt,
  updatedAt
}

agentRuns[runId] = {
  status: "running",
  source: "api",
  prompt,
  createdAt,
  updatedAt
}
```

その後、同じ`runId`と`requestId`を`AgentSupervisor.enqueueRun`へ渡す。

## Queue semantics

v1では、同一fileIdで同時に実行されるrunは1件だけである。

- `AgentSupervisor`はfileIdごとに`pending` queueを持つ。
- `enqueueRun`はrequestをpendingへ追加し、workerがreadyかつidleなら即座にflushする。
- workerがbusyの場合、新しいrequestはpendingに残る。
- workerから`runFinished`または`workerFailed`が返ったら、supervisorはbusyを解除し、次のpending requestをflushする。

serverの`startAgentFromInstructionRequests`は、active runがある場合は新しいqueued requestをclaimしない。これにより、置き手紙由来の2件目以降のrequestはYjs上で`queued`のまま残り、次回`onChange`または再接続時に処理対象になる。

## IPC protocol

serverからworker:

```ts
type AgentWorkerRequestMessage =
  | {
      type: "runQueued";
      fileId: FileId;
      request: AgentRunQueueRequest;
    }
  | {
      type: "shutdown";
      reason?: string;
    };
```

workerからserver:

```ts
type AgentWorkerResponseMessage =
  | { type: "ready"; fileId: FileId }
  | { type: "runStarted"; fileId: FileId; runId: string }
  | {
      type: "runFinished";
      fileId: FileId;
      runId: string;
      status: "proposed" | "conflicted" | "failed";
    }
  | {
      type: "workerFailed";
      fileId: FileId;
      error: string;
      runId?: string;
    };
```

Worker processは`fork`で起動する。

```ts
fork(workerEntry, ["--daemon", "--file-id", fileId, "--server-url", serverUrl], {
  execArgv: ["--import", "tsx"],
  stdio: ["pipe", "pipe", "pipe", "ipc"],
});
```

## Worker daemon loop

Workerの`--daemon` modeは以下の順に動作する。

```text
boot
  -> parse args
  -> prepareWorkspace(fileId)
  -> create Codex instance
  -> start file-scoped Codex thread
  -> send ready
  -> wait for IPC

runQueued
  -> append request to local queue
  -> if not running, drain queue

drain
  -> shift next request
  -> send runStarted
  -> thread.run(buildPrompt(fileId, runId, requestId, prompt))
  -> on success: send runFinished(status: proposed)
  -> on error: send workerFailed(error)
  -> continue drain

shutdown
  -> exit 0
```

Codex threadはfileId単位で生成し、同じworker process内の複数runで再利用する。runごとの正しさは将来的な`baseScene`、`finalScene`、`currentScene`比較に依存させ、Codex threadの会話履歴には依存しない。

## State transitions

### File metadata

`files.agent_status`は、serverから見たworker/fileの大まかな状態である。

```text
POST /api/files       -> idle
ensureWorker          -> starting
worker ready no run   -> idle
runStarted            -> running
runFinished           -> verified
workerFailed/crash    -> failed
stopIdleWorker        -> idle
```

### Instruction request

Instruction note由来:

```text
queued
  -> running  when server claims request and enqueues run
  -> stale    when note text changed before claim
```

API由来:

```text
running  created directly by POST /api/files/:id/agent-runs
```

### Agent run

```text
running
  -> proposed    worker completed successfully in current v1 behavior
  -> conflicted  future rebase/apply conflict path
  -> failed      worker error or crash
```

Worker完了時、`AgentSupervisor`はpersisted Yjs documentを読み込み、`agentRuns[runId]`の`status`、`updatedAt`、必要に応じて`finishedAt`と`error`を更新して保存する。

## Current limitations

この設計は常駐worker、明示実行、IPC queue、Yjs metadata更新の骨格を定義する。現時点の実装では、Codex run成功後のstatusは`proposed`として扱うが、実際のrebase diff、ghost proposal生成、Approve/Reject適用はまだ`agent-rebase-apply.md`側の設計に残っている。

今後の実装では、worker run内で以下を追加する。

- run開始時にghostを除外したbase sceneを保存する。
- Codexが生成した`.excalidraw`をfinal sceneとして読み込む。
- base/final/currentからrebased patchを作る。
- conflictがあれば`conflicted`へ遷移する。
- conflictがなければ`agentProposals`とghost elementsをYjsへpublishする。

## Test coverage

現在のテストで確認すること:

- instruction textだけではrunを開始しない。
- queued requestと現在のnote textが一致する場合だけclaimする。
- note textが変わっていたqueued requestは`stale`になる。
- persisted document load時にworkerをensureし、queued requestを処理する。
- 同じdocumentへの再接続ではworkerを再利用する。
- active run中の2件目requestはqueuedのまま残る。
- daemon workerはworkspaceを準備し、`ready` IPC messageを返す。
