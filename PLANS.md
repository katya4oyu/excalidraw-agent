# Excalidraw Agent Goal

## Goal

ローカル前提のWebアプリとして、Excalidrawキャンバスを開いている間はfileIdごとのAgent Workerを常駐させる。Workerはキャンバス状態をYjs経由で監視し、人間の明示的なRun操作、または人間のキャンバス変更後30秒間の無操作を契機にCodex runを開始する。

Codex実行基盤はWorker内部のruntime adapter境界に閉じ込める。現時点の調査では、run実行についてはTypeScript SDKを第一候補として継続し、App Server run adapterの自前実装は保留する。TypeScript SDKで満たせない具体的な要件が出た場合にだけ、App Server adapterを追加する。

WorkerはCodexの実行結果をデモ図形ではなく、キャンバスに対するreviewable proposalとしてYjsへpublishする。人間はWeb UI上でproposalを確認し、ApproveまたはRejectできる。複雑な図になりそうな場合は、最終Excalidraw要素へ変換する前の補助成果物として画像生成スキルによる下書き画像proposalを許容する。

Yjs接続先はデフォルトでserver組み込みHocuspocusを使う。ただし、Web UI、server、workerが参照するYjs接続先を設定で外部サーバへ切り替えられるようにする。

Web UIにはCodex backendの状態を表示する。最低限、利用可能性、認証・ログイン状態、現在の実行状態、直近のエラー、streamed progress logを人間が確認できることを目指す。

## Non-goals

- Web UIからCodex App Serverへ直接JSON-RPC requestを投げる設計にはしない。Codex runtimeの責務はWorker内に置く。
- Worker起動とCodex run開始を同一視しない。Workerはキャンバスが開いている間に待機し、run triggerが発生したときだけCodexを呼ぶ。
- App Server clientを自前実装する前提で進めない。SDK側の進化、またはTypeScript SDKで十分なら、自前protocol実装は避ける。
- TypeScript SDK backendとApp Server backendの両方を恒久的なrun実装として持たない。ハイブリッドにする場合は、run実行ではなくCodex account/status取得などの限定用途から始める。
- 自動トリガーをデフォルトONにはしない。人間が明示的に有効化できる機能として扱う。

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
- Yjs接続先はWebの`VITE_COLLAB_URL`程度の切替に留まっており、server/worker/Webをまたぐ設定モデルになっていない。
- 自動トリガー用のcanvas change debounce、30秒idle timer、cooldown、dedupe、UI toggleがない。

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

### Yjs endpoint configuration

- デフォルト設定では現在の組み込みHocuspocus `/collab` が使われる。
- 設定により外部Yjs/Hocuspocus URLへ切り替えられる。
- Web UI、server、workerが同じdocumentNameと接続先設定を共有できる。
- 外部Yjs利用時にserver persistenceとworker direct connectionの責務が明確で、少なくとも設定ミスマッチを検出してUIまたはAPIに表示できる。

### Real proposal pipeline

- WorkerはCodex run開始時にbase scene snapshotを固定する。
- Codexの成果物はdemo proposalではなく、final sceneまたはpatchとして読み込まれる。
- base/final/currentの比較からadd/update/delete/move proposalを作成する。
- Proposalはghost要素としてキャンバス上に表示され、proposal metadataにrunId、requestId、source、base情報、createdAtが保存される。
- Approveはproposalを現在のsceneに適用し、ghost metadataを残さず通常要素へ昇格または既存要素へ反映する。
- Rejectはghost proposalを見えない状態にし、footer/UIがproposal pendingとして残らない。
- Proposal作成後に人間が競合する変更をした場合、Approve時にstale/conflictedとして扱える。
- 複雑な図の画像生成draftを使う場合、その画像は補助proposalとして扱われ、最終適用可能なcanvas変更とは区別される。

### Verification

- `mise run typecheck`が成功する。
- `mise run test`が成功する。
- Worker trigger、auto idle debounce、proposal approve/reject、Codex status APIについて自動テストがある。
- ブラウザでmanual Run、Auto mode OFF、Auto mode ONの30秒idle trigger、proposal Approve、proposal Rejectが確認できる。
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
- Codex login/account/status表示については、run backendとは分離して扱う。TypeScript SDKにはaccount/status APIがないため、次の調査で「Codex CLIやconfigから安全に読めるか」「App Serverのaccount/readだけを短命probeとして使うか」「TS SDKの将来対応を待てるか」を比較する。
- App Serverを使う場合でも、最初は恒久的なdual runtimeではなく、account/status probeまたは小さなspikeに限定する。

### Remaining questions

- Web UIに表示したいlogin情報は、account idやplan typeまで必要か、単に「利用可能/未ログイン/エラー」で十分か。
- TypeScript SDK runの失敗eventだけで未ログイン状態を十分に判定できるか。
- `codex app-server`のaccount/readをstatus probeとして起動するコスト、安定性、ログイン副作用は許容できるか。
- TypeScript SDKの今後のApp Server対応を待つ場合、status UI要件をどこまで遅らせられるか。

### Evidence to collect

- TypeScript SDK run failure時に未ログイン、権限待ち、rate limit、network failureを区別できるか確認する。
- `codex app-server`の`account/read`、`auth status`、`account/rateLimits/read`を短命プロセスで呼んだ場合のレスポンス、起動時間、失敗時stderrを確認する。
- App Serverのtyped notificationをTypeScriptで直接扱う必要が出た場合、`openai/codex/codex-rs/app-server-protocol/schema/typescript/v2`を取り込めるか確認する。

### Decision rule

- TypeScript SDKでrun trigger、stream logs、structured output、image input、abort、認証失敗検出が十分なら、run backendはTypeScript SDK adapterに固定し、App Server run adapterは作らない。
- account/login/statusだけが不足する場合は、run backendをハイブリッド化せず、server側のCodex status providerとして別設計にする。
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
7. Yjs endpoint設定をserver/worker/Webで共有できる形にする。
8. Demo proposalを廃止し、Codex outputからreal proposalを作るpipelineを実装する。
9. Approve/Reject、stale/conflict、proposal footer状態を完成させる。
10. ブラウザ検証と自動テストを整備する。
