# Excalidraw Agent Goal

## Goal

ローカル前提のWebアプリとして、Excalidrawキャンバスを開いている間はfileIdごとのAgent Workerを常駐させる。Workerはキャンバス状態をYjs経由で監視し、人間の明示的なRun操作、または人間のキャンバス変更後30秒間の無操作を契機にCodex runを開始する。

Codex実行基盤はWorker内部のruntime adapter境界に閉じ込める。現時点の調査では、run実行についてはTypeScript SDKを第一候補として継続し、App Server run adapterの自前実装は保留する。TypeScript SDKで満たせない具体的な要件が出た場合にだけ、App Server adapterを追加する。

WorkerはCodexの実行結果をデモ図形ではなく、キャンバスに対するreviewable proposalとしてYjsへpublishする。Codex成果物の正は`runs/<runId>/final.excalidraw`とし、Workerが`base-scene.json`と`final.excalidraw`の差分から内部用のderived patchを作る。人間はWeb UI上でproposalを確認し、ApproveまたはRejectできる。複雑な図になりそうな場合は、最終Excalidraw sceneに含まれる画像要素または参照要素として画像生成スキルによる下書き画像proposalを許容する。

Yjs接続先はserver組み込みHocuspocusを使う。今回の実装範囲では外部Hocuspocus/Yjsサーバへの切替は扱わず、まず組み込み`/collab`とWorker lifecycleを安定させる。

Web UIにはCodex backendの状態を表示する。最低限、利用可能性、認証・ログイン状態、現在の実行状態、直近のエラー、streamed progress logを人間が確認できることを目指す。

## Non-goals

- Web UIからCodex App Serverへ直接JSON-RPC requestを投げる設計にはしない。Codex runtimeの責務はWorker内に置く。
- Worker起動とCodex run開始を同一視しない。Workerはキャンバスが開いている間に待機し、run triggerが発生したときだけCodexを呼ぶ。
- App Server clientを自前実装する前提で進めない。SDK側の進化、またはTypeScript SDKで十分なら、自前protocol実装は避ける。
- TypeScript SDK backendとApp Server backendの両方を恒久的なrun実装として持たない。ハイブリッドにする場合は、run実行ではなくCodex account/status取得などの限定用途から始める。
- 自動トリガーをデフォルトONにはしない。人間が明示的に有効化できる機能として扱う。
- 外部Hocuspocus/Yjsサーバ接続、外部Yjs persistence、組み込みserverから外部Yjsへのmirror/backup、外部接続時のlifecycle設計は今回のPLANSでは扱わない。

## Current Gaps

- `apps/worker`は`@openai/codex-sdk`の`Codex`を直接importしており、runtime adapter境界がない。
- 現行TypeScript SDKは`codex exec --experimental-json`をspawnする実装で、App Server protocolを使っていない。
- openai/codexのPython SDKは`codex app-server --listen stdio://`を起動し、JSON-RPC v2で通信する実装になっている。
- TypeScript SDKには現時点でApp Serverへの移行中コードやApp Server client実装は見当たらない。
- TypeScript SDKの公開event modelは`thread.started`、`turn.started`、`item.started/updated/completed`、`turn.completed/failed`中心で、item種別はagent message、reasoning、command execution、file change、MCP tool call、web search、todo、errorに限られる。
- Python App Server SDKはthread/turnの開始・resume・fork・list、turn steer/interrupt、models、typed notificationを持つが、experimentalで同一clientのactive turn consumerは1つという制約がある。
- App Server本体は`account/read`、`account/login/start`、`account/logout`、`account/rateLimits/read`、`account/updated`通知など、Codex account/auth状態を扱うAPIを持つ。
- WorkerはCodex実行後の成果物を読まず、固定のdemo proposal要素をpublishしている。
- Proposal applyはadd寄りのprototypeで、update/delete/move、conflict check、stale判定、reject後のUI状態整理が未完成。
- Web UIにCodex backendのlogin/account/statusを表示するAPIとUIがない。
- 組み込み`/collab`の接続種別、documentName、Worker lifecycleの関係がコード上で読み取りづらい。
- 自動トリガー用のcanvas change debounce、30秒idle timer、cooldown、dedupe、UI toggleがない。

## Resolved Design Answers

### 1. Codex artifact contract

- Codex runの正規成果物は`runs/<runId>/final.excalidraw`にする。
- Workerがrun開始時に保存する`runs/<runId>/base-scene.json`は、Codexが読む入力であり、diffのbaseでもある。
- WorkerはCodex run後に`final.excalidraw`を読み、`base-scene.json`との差分から内部成果物`runs/<runId>/derived.patch.json`を生成する。
- `derived.patch.json`はWorker内部のproposal/apply用表現であり、Codexに直接書かせる必須成果物ではない。
- `runs/<runId>/...`はリポジトリ内には置かない。実体はWorker workspace配下、初期値では`~/.excalidraw-agent/<fileId>/runs/<runId>/...`に置く。
- disposableな検証画像、render preview、一時スクリーンショットもリポジトリ内には置かず、Worker workspace配下または`/private/tmp`配下に置く。
- この方針でうまくいくと考える理由は、CodexがExcalidraw MCPやskillで実際にsceneを作成・視覚確認する流れと一致し、同時にWorker側ではreview/applyに必要なpatch表現を持てるためである。
- 初期実装では`final.excalidraw`からのdiffはadd中心に制約してよい。既存要素のupdate/delete/moveは検出してもunsupportedまたはconflictedに倒し、縦の動作を先に通す。
- 画像生成draftを使う場合も、最終成果物は`final.excalidraw`であり、draft画像はimage elementまたは参照noteとしてscene内に含める。

### 1.1 Base revision identity

- `baseRevision`は初期実装ではYjs state vectorではなく、canonical scene hashとelement version snapshotの組み合わせで表す。
- canonical scene hashは、visible elements、assets metadata、notesを安定順序で正規化したJSONから計算する。
- hash計算では、ephemeralなselection、viewport、awareness、agent presence、proposal ghost、transient UI stateは除外する。
- element version snapshotは、base時点の各visible elementについて`id`、`version`、`versionNonce`、`updated`、`isDeleted`、必要なら`index`を保存する。
- Approve時のconflict checkでは、proposal対象elementのcurrent snapshotをbase snapshotと比較する。
- Yjs state vectorは将来のsync/debug用途には残せるが、初期のproposal conflict判定の正にはしない。

### 2. Run request storage and schema

- 新規run requestの正規保存先はYjs mapの`agentRunRequests`にする。
- 既存の`agentInstructionRequests`は互換bridgeとして残す。既存requestを検出した場合は、同等の`agentRunRequests` entryへ転記または読み替える。
- 新規Web UI、manual Run、auto idle、APIは`agentRunRequests`へ書き込む。
- request idはmap keyとし、run開始時に`runId`を付与する。
- 初期schema:

```ts
type AgentRunRequest = {
  schemaVersion: 1;
  status: "queued" | "running" | "proposed" | "applied" | "rejected" | "stale" | "failed";
  source: "manual" | "auto-idle" | "instruction-note" | "api";
  prompt: string;
  fileId: string;
  runId?: string;
  trigger: {
    type: "button" | "idle-after-edit" | "instruction-note" | "api";
    idleMs?: number;
    changedElementIds?: string[];
  };
  baseRevision?: string;
  createdAt: number;
  updatedAt: number;
};
```

### 3. Auto mode scope

- Auto modeは初期実装ではfileId document内の共有状態にする。
- 保存先はYjs mapの`agentSettings`を想定し、`agentSettings.autoModeEnabled`と`agentSettings.autoIdleMs`を持たせる。
- 複数タブで同じfileIdを開いた場合、Auto modeのON/OFFは共有される。
- ローカルWebアプリ前提では、タブごとにAuto modeが食い違うより、同じcanvasに対するagent挙動が一致するほうを優先する。

### 4. Worker lifecycle close detection

- Workerは`/files/:id`を開いた人間のWebSocket接続がある間ensureされる。
- serverはHonoの`/collab` WebSocket endpointで接続を受け、同じserver process内のHocuspocusへ`handleConnection`で渡す。Hocuspocusが別portや別processで待ち受ける設計ではない。
- BrowserとWorkerはどちらも`HocuspocusProvider`を作成し、同じ`/collab` endpointへ接続する。
- `fileId`は`/collab` URLのpath/queryには入れず、Hocuspocus documentNameの`file:<fileId>`としてProviderの`name`に渡す。server側hookはHocuspocus protocolで受け取った`documentName`から`fileId`を復元する。
- `/collab` URLのqueryは接続種別などの補助情報だけに使う。Worker自身のYjs同期接続は`source=worker`を付け、人間接続数には含めない。
- close判定は組み込みHocuspocus/WebSocket hookで観測できる人間接続のfileId別接続数で行う。
- 接続数が0になったらすぐ止めず、初期値60秒のgrace period後にidle workerを停止する。
- リロードや短時間のタブ切替はgrace period内なら同じWorkerを再利用する。
- 明示release APIは初期必須にしない。必要になったら追加する。

### 5. Minimal proposal conflict rules

- 初期のconflict判定は厳密なproperty mergeをしない。
- proposalには`baseRevision`、対象element id、base時点の`version`、`updated`、`isDeleted`を保存する。
- Approve時にcurrent sceneの対象elementがbase時点から変わっていれば、そのoperationはstale/conflictedにする。
- add operationはfinal idがcurrentに既に存在する場合にconflictedにする。
- update/delete/moveは初期ではunsupportedまたはconflictedに倒してよい。add-onlyの縦動線を最優先する。

### 6. Initial Codex status UI goal

- 初期Codex statusはserver側で`codex login status`を実行して判定する。
- Web UIに出す情報は`available`、`not_logged_in`、`error`、`authMethod`まででよい。
- `authMethod`はChatGPT、API key、access token程度に正規化する。
- account id、plan type、rate limitは初期ゴールに含めない。必要になった時点でApp Serverの`account/read`、`account/rateLimits/read`を検討する。

### 7. Embedded Yjs and collaboration responsibility

- server組み込みHocuspocusとserver内蔵persistenceを使う。
- Web UIとWorkerは同じ組み込み`/collab` endpointへ接続する。
- 同じcanvasへ接続する正はHocuspocus documentNameの`file:<fileId>`であり、`/collab` URLそのものではない。
- Browser接続、Worker接続、API/direct connectionをserver側で区別し、Worker lifecycleの人間接続数にはBrowser接続だけを含める。
- 外部Hocuspocus/Yjsサーバへの切替は今回のPLANSから外す。必要になった場合は、組み込み実装を完成させた後に別PLANSでlifecycle、persistence、documentName、認証、設定検証を再設計する。

### 8. Auto idle instruction

- Auto idle runは「未処理requestを実行」ではなく、現在の図に対する小さなレビュー/改善proposalを作る。
- 初期promptは「現在の図を見て、小さな改善proposalを1つ作る。不要なら何もしない」に寄せる。
- Auto runは大規模な再構成を避け、add中心のproposalに制限する。
- 明示的なmanual Runやinstruction-noteがある場合は、そのpromptを優先する。

### 9. Staged Codex turn proposal lifecycle

- WorkerはCodexを単発実行せず、`estimate -> draft steps -> verify/refine -> final proposal`の段階turnとして管理する。
- Codexは最初に`runs/<runId>/estimate.json`へ、必要領域、意図、配置理由、作成stepを保存する。
- WorkerはCodex見積もりをそのまま正にせず、既存要素、既存proposal/ghost除外、衝突回避、サイズ上限を踏まえて`plannedArea`を確定する。
- Codexのdraft成果物は`runs/<runId>/draft-step-<n>.excalidraw`とし、Workerがstep完了ごとにdraft ghostとしてYjsへpublishする。要素単位streamingは初期scope外。
- WorkerはCodex turn中もYjsを監視し、人間が変更したvisible elements/notes/assetsを`runs/<runId>/human-deltas.jsonl`へ記録し、次のCodex turnへhumanDeltaとして渡す。Agent自身のdraft/proposal/presence変更はhumanDeltaから除外する。
- 最終成果物は従来通り`runs/<runId>/final.excalidraw`で、Workerは`derived.patch.json`を作りfinal proposal ghostへ変換する。
- Workerは`runs/<runId>/quality-report.json`へ構造チェック、plannedAreaチェック、視認可能なadd要素の有無、refine有無を保存する。
- 品質チェックが失敗した場合、Codexに1回だけrefine turnを送る。refine後も失敗した場合、不完全なproposalを成功扱いせずrunをfailedにする。
- draft ghost、plannedArea overlay、Agent presenceはrunning中だけ見せ、proposal確定、approve、reject、failed、cancel後に残さない。

## Acceptance Criteria

### Worker lifecycle and triggers

- `/files/:id`を開いている間、serverは該当fileIdのWorkerをensureし、WorkerはCodex runを開始せずidleで待機する。
- Runボタン押下で、Yjs上にmanual sourceのrun requestが作成され、server/worker queue経由でCodex runが開始される。
- Auto modeがONのときだけ、人間によるキャンバス変更後30秒間の無操作でauto-idle sourceのrun requestが作成される。
- Auto modeがOFFのとき、キャンバス変更だけではCodex runは開始されない。
- Run中またはproposal pending中は、同一fileIdに対して重複auto runが作成されない。
- Agent自身のghost proposal publish、approve、rejectによるYjs変更はauto triggerの対象外になる。
- Auto triggerにはcooldownまたはdedupeがあり、細かい編集で連続runが暴発しない。

### Codex runtime boundary

- Workerは`CodexRuntime`のようなadapter interfaceを通じてCodexを呼び、Worker本体がTypeScript SDKやApp Server protocolの詳細に直接依存しない。
- Runtime adapterは少なくともrun開始、streamed event/log、final response、エラー、abortまたはinterrupt相当の扱いをWorkerへ返せる。
- TypeScript SDK継続かApp Server直接利用かの判断は、openai/codexのTypeScript SDK、Python SDK、App Server protocolの挙動差を調査した記録に基づく。
- App Server自前clientを実装する場合は、TypeScript SDKでは満たせない具体的な要件がPLANSまたは設計docに明記されている。
- SDK対応待ちで十分と判断する場合は、その根拠と暫定adapter設計が明記されている。

### Codex backend status UI

- serverはCodex backend statusを返すAPIを提供する。
- Web UIはCodex backendの利用可能性、認証・ログイン状態、選択runtime、直近エラーを表示する。
- Codex run中はstreamed progress logまたはそれに相当するworker progressがWeb UIに表示される。
- ログイン未完了またはCodexが利用できない場合、RunボタンとAuto modeは安全に無効化または明確なエラー表示になる。

### Embedded Yjs collaboration

- 組み込みHocuspocus `/collab` が使われる。
- BrowserとWorkerは同じ`documentName = file:<fileId>`へ接続する。
- `fileId`は`/collab` URLではなくHocuspocus Providerの`name`として渡され、server hookの`documentName`から復元できる。
- Worker自身の同期接続は人間接続数から除外される。
- server内蔵persistenceが組み込みHocuspocus documentを保存・復元する。

### Real proposal pipeline

- WorkerはCodex run開始時にbase scene snapshotを固定する。
- Workerはbase sceneからcanonical scene hashとelement version snapshotを作り、`baseRevision`としてrequest/proposal metadataへ保存する。
- WorkerはCodex runを段階turnとして実行し、`estimate.json`、`draft-step-<n>.excalidraw`、`human-deltas.jsonl`、`quality-report.json`をWorker workspace配下に保存する。
- WorkerはCodex見積もりを検証・補正して`plannedArea`を確定し、Yjs上の`agentRuns.phase`、`agentRuns.plannedArea`、`agentRuns.humanDeltaCount`を更新する。
- Draftはstep単位でYjsへpublishされ、前stepのdraft ghostを置き換える。Draft ghostはfinal proposalとは区別され、`agentProposals`のpending proposalにはしない。
- WorkerはCodex turn中に人間側のYjs変更を検知し、次turnのpromptにhumanDeltaとして含める。
- Codexの正規成果物として`runs/<runId>/final.excalidraw`が作成される。
- `runs/<runId>/...`の実体はリポジトリ外のWorker workspace配下に作成される。
- Workerは`base-scene.json`と`final.excalidraw`を比較し、内部用の`derived.patch.json`を生成する。
- 初期実装ではderived patchのadd operationを優先してproposal化し、update/delete/moveはunsupportedまたはconflictedに倒せる。
- Proposalはghost要素としてキャンバス上に表示され、proposal metadataにrunId、requestId、source、base情報、createdAtが保存される。
- Final proposal ghostは青い破線へ強制変換せず、元の図形スタイルを保った半透明・locked要素として表示する。
- Approveはproposalを現在のsceneに適用し、ghost metadataを残さず通常要素へ昇格または既存要素へ反映する。
- Rejectはghost proposalを見えない状態にし、footer/UIがproposal pendingとして残らない。
- Proposal作成後に人間が競合する変更をした場合、Approve時にstale/conflictedとして扱える。
- 複雑な図の画像生成draftを使う場合、その画像は補助proposalとして扱われ、最終適用可能なcanvas変更とは区別される。

### Verification

- `mise run typecheck`が成功する。
- `mise run test`が成功する。
- Worker trigger、auto idle debounce、proposal approve/reject、Codex status APIについて自動テストがある。
- ブラウザ検証は必ず実際の起動方法で行う。`mise run server:portless`と`mise run web:portless`で起動し、`http://excalidraw-agent.localhost:1355`のrootから実ユーザーフローを開始する。raw `localhost`起動や`/files/:id`直開きだけでは完了扱いにしない。
- 検証は起動、page load、rootから`/files/:id`への遷移、`Collab: synced`、footerの`worker ready`だけで止めない。変更が実装したと主張する機能について、該当するtrigger、UI状態、network/WebSocket経路、Worker lifecycle、生成artifact、proposal、Approve/Reject、エラー表示まで、ユーザーが使う一連の動作を通す。
- Agent/Worker機能では、最低限`/files/:id`で`Collab: synced`とfooterの`worker ready`を確認した上で、manual Run、Auto mode OFF、Auto mode ONの30秒idle trigger、proposal Approve、proposal Rejectのうち、その変更に関係するものを最後まで確認する。
- `http://api.excalidraw-agent.localhost:1355/api/codex/status`が404ではなくCodex status JSONを返し、`ws://api.excalidraw-agent.localhost:1355/collab`へのWebSocket接続がブラウザconsoleで失敗していないことを確認する。
- 検証用スクリーンショットなどの一時成果物はリポジトリ外に置かれる。

## SDK and App Server Investigation Plan

### Findings from openai/codex

- `openai/codex/sdk/typescript/README.md`は、TypeScript SDKが`@openai/codex` CLIをspawnし、stdin/stdoutでJSONL eventを交換すると明記している。
- `openai/codex/sdk/typescript/src/exec.ts`は`["exec", "--experimental-json"]`を組み立ててspawnしている。App Server transportは使っていない。
- `openai/codex/sdk/typescript/src/thread.ts`は`runStreamed()`でexec JSONLを`ThreadEvent`へparseし、`run()`で`item.completed`と`turn.completed/failed`を集約する薄いwrapperである。
- TypeScript SDKはstructured output、local image input、thread resume、working directory、sandbox、approval policy、network/web search config、abort signalを扱える。
- TypeScript SDKのevent型にはaccount/auth/login/status、turn steer、明示interrupt response、rate limit、account update notificationは含まれていない。
- `openai/codex/sdk/python/README.md`はPython SDKを「Codex App Server Python SDK (Experimental)」と位置づけ、`codex app-server` JSON-RPC v2 over stdioを使うと説明している。
- `openai/codex/sdk/python/src/codex_app_server/client.py`は`codex app-server --listen stdio://`を起動し、`initialize`、`thread/start`、`turn/start`、`turn/interrupt`、`turn/steer`などをJSON-RPCで呼ぶ。
- Python SDK docsは`TurnHandle.stream()`、`steer()`、`interrupt()`、canonical generated model、typed notificationを公開している一方、experimentalで同一clientにactive turn consumerは1つという制約を明記している。
- `openai/codex/codex-rs/app-server/src/request_processors/account_processor.rs`には`get_account`、`get_auth_status`、`login_account`、`logout_account`、`get_account_rate_limits`がある。Codex login/account状態をUIに表示する用途はApp Serverのほうが自然に満たせる。

### Provisional decision

- いまはrun実行をTypeScript SDKとApp Serverのハイブリッドにしない。
- Workerにはまず`CodexRuntime` adapterを導入し、初期実装はTypeScript SDK backendにする。
- App Server run adapterは、TypeScript SDKでは満たせない必須要件が確認されるまで実装しない。
- Codex login/account/status表示については、run backendとは分離して扱う。暫定実装では`codex login status`をserver側で実行し、利用可能/未ログイン/認証方式だけをWeb UIへ出す。
- App Serverの`account/read`やrate limitsは、account id、plan type、rate limit、login flow制御が必要になった場合の次段にする。
- App Serverを使う場合でも、最初は恒久的なdual runtimeではなく、account/status probeまたは小さなspikeに限定する。

### Remaining questions

- 暫定Web UIは「利用可能/未ログイン/エラー」と認証方式表示で十分か。account idやplan typeが必要になった時点でApp Server account APIを検討する。
- TypeScript SDK runの失敗eventだけで未ログイン状態を十分に判定できるか。
- `codex login status`のstderr出力とexit codeをserver APIで安定して扱えるか。
- `codex app-server`のaccount/readをstatus probeとして起動するコスト、安定性、ログイン副作用は許容できるか。
- TypeScript SDKの今後のApp Server対応を待つ場合、status UI要件をどこまで遅らせられるか。

### Evidence to collect

- TypeScript SDK run failure時に未ログイン、権限待ち、rate limit、network failureを区別できるか確認する。
- `codex login status`をserverから実行し、ChatGPT/API key/access token/not logged in/errorを安全に正規化できるか確認する。
- `codex login status`で足りない場合だけ、`codex app-server`の`account/read`、`auth status`、`account/rateLimits/read`を短命プロセスで呼んだ場合のレスポンス、起動時間、失敗時stderrを確認する。
- App Serverのtyped notificationをTypeScriptで直接扱う必要が出た場合、`openai/codex/codex-rs/app-server-protocol/schema/typescript/v2`を取り込めるか確認する。

### Decision rule

- TypeScript SDKでrun trigger、stream logs、structured output、image input、abort、認証失敗検出が十分なら、run backendはTypeScript SDK adapterに固定し、App Server run adapterは作らない。
- account/login/statusだけが不足する場合は、run backendをハイブリッド化せず、server側のCodex status providerとして別設計にする。暫定providerは`codex login status`を使う。
- App Serverにしかないturn steer/interrupt、approval reviewer、typed permission flowがこのアプリの必須UXになった場合だけ、App Server run adapterを設計する。
- App Server run adapterを設計する場合も、Python SDK subprocess bridgeとTypeScript JSON-RPC clientのspikeを比較し、保守コストが低い方を選ぶ。
- TypeScript SDKがApp Server protocolへ移行中で短期に取り込めそうなら、Worker側はadapter境界とstatus APIだけ先に整え、SDK更新待ちにする。

## Implementation Milestones

1. Runtime調査と設計判断を文書化する。
2. WorkerのCodex呼び出しをruntime adapterへ分離する。
3. Worker lifecycleをキャンバスopen/closeに合わせ、idle常駐とrun triggerを明確化する。
4. Manual Run request schemaを`agentInstructionRequests`から汎用run requestへ整理する。
5. Auto mode UI、30秒idle detector、dedupe/cooldownを追加する。
6. Codex backend status APIとWeb UI表示を追加する。
7. 組み込み`/collab`の接続種別、documentName、server内蔵persistenceの責務を整理する。
8. Demo proposalを廃止し、Codex outputからreal proposalを作るpipelineを実装する。
9. Approve/Reject、stale/conflict、proposal footer状態を完成させる。
10. ブラウザ検証と自動テストを整備する。
