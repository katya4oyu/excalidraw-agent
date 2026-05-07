# Excalidraw Agent Goal

## Goal

ローカル前提のWebアプリとして、Excalidrawキャンバスを開いている間はfileIdごとのAgent Workerを常駐させる。Workerはキャンバス状態をYjs経由で監視し、人間の明示的なRun操作、または人間のキャンバス変更後30秒間の無操作を契機にCodex runを開始する。

Codex実行基盤はWorker内部のruntime adapter境界に閉じ込める。現時点ではTypeScript SDKを直接利用しているが、TypeScript SDK、Python SDK、Codex App Serverの挙動差をコードベース調査で明らかにしてから、TypeScript SDK継続、App Server直接実装、または将来のSDK対応待ちのどれを採るか決める。

WorkerはCodexの実行結果をデモ図形ではなく、キャンバスに対するreviewable proposalとしてYjsへpublishする。人間はWeb UI上でproposalを確認し、ApproveまたはRejectできる。複雑な図になりそうな場合は、最終Excalidraw要素へ変換する前の補助成果物として画像生成スキルによる下書き画像proposalを許容する。

Yjs接続先はデフォルトでserver組み込みHocuspocusを使う。ただし、Web UI、server、workerが参照するYjs接続先を設定で外部サーバへ切り替えられるようにする。

Web UIにはCodex backendの状態を表示する。最低限、利用可能性、認証・ログイン状態、現在の実行状態、直近のエラー、streamed progress logを人間が確認できることを目指す。

## Non-goals

- Web UIからCodex App Serverへ直接JSON-RPC requestを投げる設計にはしない。Codex runtimeの責務はWorker内に置く。
- Worker起動とCodex run開始を同一視しない。Workerはキャンバスが開いている間に待機し、run triggerが発生したときだけCodexを呼ぶ。
- App Server clientを自前実装する前提で進めない。SDK側の進化で十分なら、自前protocol実装は避ける。
- 自動トリガーをデフォルトONにはしない。人間が明示的に有効化できる機能として扱う。

## Current Gaps

- `apps/worker`は`@openai/codex-sdk`の`Codex`を直接importしており、runtime adapter境界がない。
- 現行TypeScript SDKは`codex exec --experimental-json`をspawnする実装で、App Server protocolを使っていない。
- openai/codexのPython SDKは`codex app-server --listen stdio://`を起動し、JSON-RPC v2で通信する実装になっている。
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

### Questions

- TypeScript SDKの`codex exec --experimental-json`経由で、必要なstreamed event、approval、auth/account/status、interrupt、structured output、image input、working directory制御を満たせるか。
- Python SDKのApp Server経由で提供される機能のうち、このアプリに必要でTypeScript SDKにないものは何か。
- App Server protocolをTypeScriptで自前実装する場合、保守コストに見合う差分はあるか。
- TypeScript SDKが近い将来App Server化する見込みがコード上で読み取れるか。
- 当面はTypeScript SDK adapterで十分か、それともApp Server adapterを先に用意すべきか。

### Evidence to collect

- `openai/codex/sdk/typescript/src/exec.ts`と`thread.ts`で、spawnされるCLI args、stream event model、thread resume、abort、structured output、image inputの仕様を確認する。
- `openai/codex/sdk/python/src/codex_app_server/client.py`、`_run.py`、docs/api-referenceで、App Server clientのthread/turn/status/account/approvalの公開面を確認する。
- `openai/codex/codex-rs/app-server-protocol/schema/typescript/v2`で、TypeScript向けschemaが実用可能か確認する。
- `openai/codex/codex-rs/app-server/src/request_processors/account_processor.rs`で、Web UIに出したいaccount/login/status情報がApp Serverから取得可能か確認する。
- `openai/codex/codex-rs/app-server/src/request_processors/turn_processor.rs`とprotocol event mappingで、streamed progressをWorker presenceへ変換できるか確認する。

### Decision rule

- TypeScript SDKでrun trigger、stream logs、structured output、image input、abort、認証失敗検出が十分なら、まずTypeScript SDK adapterを継続し、App Server自前実装は保留する。
- App Serverにしかないaccount/login/statusやapproval handlingがWeb UI要件に必須なら、App Server adapterを設計する。ただし、Python SDKをnode workerから呼ぶ暫定案と、TypeScriptでJSON-RPC clientを実装する案を比較して決める。
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
