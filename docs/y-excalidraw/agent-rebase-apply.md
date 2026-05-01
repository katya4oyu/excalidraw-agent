# Agent rebase apply design

## Goal

Agent は作業開始時点のYjs sceneをbaseとして固定し、`.excalidraw` ファイルをheadlessに作成・視覚検証した後、agentがbaseから変更した差分をproposalとしてYjsへ公開する。

これはGitでいう、作業開始時点のbaseからagent branchを作り、apply時点のcurrentへagent commitをrebaseして、衝突がなければ反映するモデルである。

agentの成果物は、人間がApproveするまでは通常要素として扱わない。まず `elements` にghost属性付きのExcalidraw要素として入れ、Canvas上に実際の要素として表示する。Approve後にだけ、ghost要素を完全版の通常要素へ昇格、または既存要素へ置き換える。

```text
base scene
   ├── human/browser edits ──> current Yjs scene
   └── agent edits ─────────> final .excalidraw scene

apply:
  agent patch = diff(base scene, final scene)
  proposal    = insert ghost elements into Yjs elements
  approved    = promote/replace ghost elements
```

## Non-goals

- Yjs document全体を `replaceScene` で無条件上書きしない。
- 人間のApprove前にagent成果物を通常要素としてcommitしない。
- 同一要素同時編集の自動mergeはしない。
- Excalidraw element key単位のCRDT化はしない。
- agent作業中マーカーをcanvas要素として追加しない。
- Agent Skills / `mcp_excalidraw` 自体の描画品質改善は扱わない。

## Yjs metadata

agent作業中の目印はcanvas要素ではなく、同じYjs document内のmetadata mapへ書く。

```text
Y.Doc
├─ elements
│  ├─ normal Excalidraw elements
│  └─ ghost Excalidraw elements
├─ assets
├─ agentRuns
│  └─ runId -> AgentRunState
└─ agentProposals
   └─ runId -> AgentProposalState
```

`agentRuns` はWeb UIがobserveして、agent作業中、適用済み、conflict、failedを表示するために使う。図面本体には混ぜない。

`agentProposals` は、proposal全体の状態、patch、ghost要素ID、Approve/Reject結果を管理するために使う。ghostの見た目そのものは `elements` に入ったExcalidraw要素で表現する。

```ts
type AgentRunStatus =
  | "running"
  | "proposed"
  | "applying"
  | "applied"
  | "rejected"
  | "conflicted"
  | "failed";

type AgentRunState = {
  runId: string;
  documentName: string;
  status: AgentRunStatus;
  startedAt: number;
  finishedAt?: number;
  workerId?: string;
  prompt?: string;
  baseHash: string;
  baseSnapshotRef?: string;
  finalSnapshotRef?: string;
  applyMode: "rebase";
  conflictPolicy: "fail";
  presence?: AgentRunPresence;
  summary?: AgentApplySummary;
  conflicts?: AgentApplyConflict[];
  error?: string;
};

type AgentProposalState = {
  runId: string;
  status: "proposed" | "approved" | "rejected" | "stale";
  createdAt: number;
  updatedAt: number;
  baseHash: string;
  finalHash: string;
  patch: RebasedScenePatch;
  ghostElementIds: string[];
  conflicts?: AgentApplyConflict[];
};

type AgentGhostCustomData = {
  kind: "agent-ghost";
  runId: string;
  proposalId: string;
  operation: "add" | "update" | "delete" | "move";
  targetElementId?: string;
  finalElementId?: string;
  createdAt: number;
};

type AgentRunPresence = {
  message?: string;
  intent?: string;
  focus?: AgentRunFocus[];
  updatedAt: number;
};

type AgentRunFocus =
  | {
      type: "bounds";
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      confidence?: "low" | "medium" | "high";
    }
  | {
      type: "elements";
      elementIds: string[];
      label?: string;
      confidence?: "low" | "medium" | "high";
    };
```

`baseSnapshotRef` と `finalSnapshotRef` は、DB、workspace file、object storageなどの外部保存先を指す文字列にする。Yjs metadataには巨大なscene JSONを直接入れない。

`presence` は、人間にagentの作業予定や作業中領域を見せるための軽量metadataである。Excalidraw elementとして保存しない。

## Lifecycle

### 1. Start run

agent worker開始時に、現在のYjs sceneを読む。

```text
baseScene = core.readScene(stores)
baseHash  = hashCanonicalScene(baseScene)
baseRef   = persistBaseSnapshot(baseScene)
```

その後、Yjs transactionで `agentRuns[runId]` を作る。

```ts
startAgentRun(stores, {
  runId,
  documentName,
  workerId,
  prompt,
  baseHash,
  baseSnapshotRef: baseRef,
  origin: agentOrigin,
});
```

statusは `"running"` にする。

### 2. Agent work

agentはworkspace内で `.excalidraw` ファイルを作成・更新する。Agent Skills / `mcp_excalidraw` を使って、構文と見た目を検証する。

この段階では `elements` には書かない。作業中状態は `agentRuns` metadataだけに残る。

agentが作業対象や配置予定領域を判断できる場合は、作業前または作業中に `agentRuns[runId].presence` を更新する。これは人間側への「ここを触る予定です」という予告・牽制として使う。

```ts
updateAgentRunPresence(stores, runId, {
  intent: "Add a deployment flow diagram",
  message: "Agent is drafting a diagram in the lower-right area.",
  focus: [
    {
      type: "bounds",
      x: 900,
      y: 240,
      width: 640,
      height: 420,
      label: "planned agent work area",
      confidence: "medium",
    },
  ],
  updatedAt: Date.now(),
});
```

### 3. Begin proposal creation

検証済みsceneを読み込む。この時点ではまだ本体 `elements` へは適用せず、`agentRuns[runId].status` は `"running"` のままでもよい。

```text
finalScene = loadExcalidrawFile(finalPath)
finalHash  = hashCanonicalScene(finalScene)
finalRef   = persistFinalSnapshot(finalScene)
current    = core.readScene(stores)
```

### 4. Create rebased patch

`baseScene`, `finalScene`, `currentScene` の3つを比較する。

```ts
const patch = createRebasedScenePatch({
  baseScene,
  finalScene,
  currentScene,
  conflictPolicy: "fail",
});
```

patchは、agentがbaseから変更した内容だけを表す。

```ts
type RebasedScenePatch = {
  add: ExcalidrawElement[];
  update: ExcalidrawElement[];
  delete: string[];
  move: ElementMove[];
  assets: AssetPatch;
};
```

### 5. Publish proposal or conflict

conflictがなければ、patchを通常要素としては適用せず、ghost属性付きのExcalidraw要素を `elements` へ挿入する。同時に `agentProposals[runId]` へproposal状態とghost要素IDを保存する。

```ts
publishAgentProposal(stores, {
  runId,
  patch,
  ghostElements: createGhostElements(patch),
  origin: agentOrigin,
});
```

proposal作成時:

```text
agentRuns[runId].status = "proposed"
agentProposals[runId].status = "proposed"
agentProposals[runId].ghostElementIds = [...]
```

conflict時:

```text
agentRuns[runId].status = "conflicted"
agentRuns[runId].conflicts = [...]
```

error時:

```text
agentRuns[runId].status = "failed"
agentRuns[runId].error = message
```

### 6. Human review

browserは `agentProposals[runId]` と `elements` 内のghost要素をobserveし、Canvas上にghost状態として表示する。ghostは実際のExcalidraw要素なので、人間は配置予定や形状を通常の図面に近い形で確認できる。

人間はproposalを確認し、ApproveまたはRejectする。

```ts
approveAgentProposal(stores, runId, {
  origin: humanOrigin,
});

rejectAgentProposal(stores, runId, {
  origin: humanOrigin,
  reason: "not useful",
});
```

Reject時は本体 `elements` を変更しない。

### 7. Approve apply

Approve時に、proposal作成時のpatchをそのまま昇格するのではなく、現在のYjs sceneに対して再度conflict checkを行う。このときcurrent scene比較では、同じrunのghost要素を除外して通常要素だけを見る。

Approve処理を開始したら `agentRuns[runId].status` を `"applying"` にする。

```text
approvalCurrent = core.readScene(stores)
revalidate proposal patch against approvalCurrent
```

衝突がなければ、サーバ側または権限を持つapply処理でghost要素を通常要素へ昇格する。

```ts
core.approveGhostProposal(stores, runId, {
  origin: humanApproveOrigin,
});
```

昇格ルール:

- `add`: ghost要素を削除し、`finalElementId` の通常要素を挿入する。
- `update`: `targetElementId` の通常要素をfinal elementへ置き換え、ghost要素を削除する。
- `delete`: `targetElementId` の通常要素とdelete ghost要素を削除する。
- `move`: `targetElementId` の `pos` / geometryをfinal stateへ更新し、move ghost要素を削除する。

成功時:

```text
agentRuns[runId].status = "applied"
agentProposals[runId].status = "approved"
```

Approve時点で衝突が発生した場合:

```text
agentRuns[runId].status = "conflicted"
agentProposals[runId].status = "stale"
```

この場合、browserは「proposal is stale; regenerate or rebase again」を表示する。

## Diff rules

要素IDを基準に比較する。

```text
baseById    = map(base.elements)
finalById   = map(final.elements)
currentById = map(current.elements)
```

agent側の変更検出:

- `id` がbaseになくfinalにある: `add`
- `id` がbaseにありfinalにもあり、element hashが違う: `update`
- `id` がbaseにありfinalにない: `delete`
- finalの `pos` / order がbaseと違う: `move`

current側の同時変更検出:

- `id` がbaseにありcurrentにもあり、element hashが違う: human/remote changed
- `id` がbaseにありcurrentにない: human/remote deleted
- `id` がbaseになくcurrentにある: human/remote added

## Conflict rules

初期仕様では、自動mergeせずにconflictとして扱う。

| Agent change | Current state | Result |
| --- | --- | --- |
| add new id | currentに同じidがない | apply |
| add new id | currentに同じidがある | conflict |
| update id | current elementがbaseから未変更 | apply |
| update id | current elementもbaseから変更済み | conflict |
| update id | current elementが削除済み | conflict |
| delete id | current elementがbaseから未変更 | apply |
| delete id | current elementもbaseから変更済み | conflict |
| delete id | current elementが削除済み | noop |
| move id | current elementが存在し、order conflictなし | apply |
| move id | current elementが削除済み | conflict |

別要素の同時編集はconflictにしない。

## Delete policy

初期仕様では、agentがbaseから削除した要素は `delete` として扱う。ただしapply前にconflict checkを行い、current側で同じ要素が変更されていた場合は削除しない。

将来的に安全性をさらに高める場合は、以下のpolicyを追加できる。

```ts
type DeletePolicy =
  | "allow-if-current-unchanged"
  | "explicit-only"
  | "agent-owned-only";
```

初期値は `"allow-if-current-unchanged"` とする。

## Hashing

hashは衝突検出のために使う。Excalidrawの一時的・環境依存fieldを必要に応じて除外し、canonical JSONとしてhashする。

初期実装では、少なくとも以下を安定化する。

- object key順を固定する。
- elementsはidでmap化し、order比較は別に扱う。
- assetsもfile idでmap化する。

除外fieldは実装時にExcalidraw 0.18のelement shapeを確認して決める。過剰に除外して変更を見落とすより、初期は保守的にhashする。

## Browser interaction

agent proposalはYjs remote updateとしてbrowserに届く。Approve前も `elements` にghost要素として届くため、Excalidraw canvas上に直接表示される。Approve後のcommitでは、ghost要素が通常要素へ昇格、または既存要素と置き換えられる。

browser側は以下を守る。

- remote/agent updateを `captureUpdate: "NEVER"` でUIへ反映する。
- remote update由来の `onChange` をYjsへ戻さない。
- humanがpointer down中ならlocal pending sceneを保持し、agent updateとmergeしてUIへ反映する。
- agent proposalがhumanの編集中要素と同じ場合、ghost preview上で警告表示する。Approve時の再検証でconflictになり得る。
- humanによるghost要素の直接編集は初期仕様では許可しない。ghost要素は `locked: true` とし、browser bindingはghost要素へのlocal editをYjs通常変更として扱わない。

## Ghost proposal UX

Approve前のagent成果物は、`elements` 内のghost要素としてcanvas上に表示する。

Ghost表示の目的:

- agentが何を追加・変更・削除しようとしているかを人間が見て判断できる。
- agent成果物を本体図面へ混ぜる前に、人間がApprove/Rejectできる。
- 人間が作業中でも、agent案を見ながら判断できる。
- rebase/diff対象の通常sceneと区別できる。

Ghost表示ルール:

- `add`: 半透明の新規ghost要素として表示する。ghostのidは通常要素の予定idとは別にする。
- `update`: 現在要素の上にghost版を重ねる。ghostには `targetElementId` を持たせる。
- `delete`: 削除予定要素の複製ghostを赤系・低opacity・strike風に表示する。本体要素はApproveまで消さない。
- `move`: 移動後位置にghostを表示する。ghostには `targetElementId` と最終位置を持たせる。
- assets: ghost要素で必要なassetはpreviewに必要な範囲で読み込む。

Ghost見た目パラメータ:

| Operation | opacity | strokeColor | backgroundColor | strokeStyle | locked | Notes |
| --- | ---: | --- | --- | --- | --- | --- |
| `add` | `35` | `#1e88e5` | `transparent` or source color with low opacity | `dashed` | `true` | 新規追加予定として、通常要素より薄く表示する。 |
| `update` | `35` | `#1e88e5` | `transparent` or source color with low opacity | `dashed` | `true` | 既存要素の上に重ね、`targetElementId` で元要素に紐づける。 |
| `delete` | `30` | `#d32f2f` | `transparent` | `dashed` | `true` | 削除予定の複製として赤系で表示する。本体要素は残す。 |
| `move` | `35` | `#1e88e5` | `transparent` or source color with low opacity | `dashed` | `true` | 移動後の位置に表示し、元要素との対応は `targetElementId` で持つ。 |

この値は初期値であり、実装時にExcalidraw 0.18で視認性と選択挙動を確認して調整する。目的は「通常要素ではないが、Canvas上で配置・形状を確認できる」状態を作ることであり、別のCanvas overlayは作らない。

GhostはExcalidraw elementとして `elements` に追加する。ただし通常要素とは区別するため、`customData` に `AgentGhostCustomData` を持つ。

```ts
const ghostElement = {
  ...finalElement,
  id: `ghost:${runId}:${finalElement.id}`,
  opacity: 35,
  strokeColor: "#1e88e5",
  backgroundColor: "transparent",
  strokeStyle: "dashed",
  locked: true,
  customData: {
    kind: "agent-ghost",
    runId,
    proposalId: runId,
    operation: "add",
    finalElementId: finalElement.id,
    createdAt: Date.now(),
  },
};
```

通常の `readScene()` は初期値としてghost要素を除外する。browser表示やproposal reviewでは `includeGhosts: true` を明示する。

Agent state UI:

- agent状態、proposal件数、Approve/Reject入口はExcalidrawの `Footer` に表示する。
- 実装では `@excalidraw/excalidraw` の `<Footer>` child componentを使う。Excalidraw内部DOMの `footer-left` / `footer-right` / `footer-center` class名を直接参照して配置しない。
- Desktopでは `<Footer>` がExcalidraw footer領域のcustom contentとして描画される。表示位置はExcalidrawのlayoutに従い、こちらでは独自absolute配置を行わない。
- 独自topbar、右上UI、Canvas overlay、ghost近傍popoverは初期実装では作らない。
- `Footer` 表示はproposal単位だけを扱う。初期実装では要素単位Approveは対象外。
- `running` はFooterにagent作業中状態を表示する。Canvas上に追加図形は出さない。
- `proposed` はCanvas上にghost要素を表示し、FooterからproposalをApprove/Rejectできる。
- `applying` / `applied` / `rejected` / `failed` / `conflicted` もFooterで状態を表示する。

Staleness:

- proposal作成後にcurrent sceneが変わった場合でも、ghostは表示し続ける。
- Approve時に再検証し、同一要素が変更されていればstale/conflictにする。
- stale proposalはApprove不可にし、再生成または再baseを促す。

## Canvas UX

Canvas UX はv1ではシンプルにする。Canvas上で増やすものはghost要素だけに限定し、agent状態や操作入口はExcalidrawの `Footer` に置く。

表示するもの:

- `running`: Footerにagent作業中状態を表示する。Canvas上に追加図形は出さない。
- `proposed`: `elements` に入ったghost要素をCanvasに表示し、Footerにproposal状態とApprove/Reject入口を出す。
- `applying`: FooterにApprove後の短い処理中状態を表示する。
- `applied` / `rejected` / `failed` / `conflicted`: Footerに結果状態を表示する。

やらないこと:

- 作業予定領域の複雑なoverlay stateは作らない。
- hover/pointer down時の予約領域warningはv1では作らない。
- hard lockはしない。
- 要素単位Approveはしない。
- 独自topbar、右上ボタン、ghost近傍popoverは作らない。

agentが作業予定領域を事前に示したい場合は、`presence.focus` ではなく、必要に応じて薄いghost要素を早めにproposalとして出す。つまり「見せたいものはghost elementとして `elements` に入れる」を基本にする。

通常のscene読取、export、base/final/current diffではghostを除外する。browser reviewではghostを含めて表示する。

## API sketch

`y-excalidraw-core`:

```ts
readScene(stores: ExcalidrawYStores, options?: { includeGhosts?: boolean }): ExcalidrawScene;
hashScene(scene: ExcalidrawScene): string;
createRebasedScenePatch(input: {
  baseScene: ExcalidrawScene;
  finalScene: ExcalidrawScene;
  currentScene: ExcalidrawScene;
  conflictPolicy: "fail";
}): RebasedPatchResult;
applyScenePatch(
  stores: ExcalidrawYStores,
  patch: RebasedScenePatch,
  options?: MutationOptions,
): void;
validateScenePatchAgainstCurrent(
  currentScene: ExcalidrawScene,
  patch: RebasedScenePatch,
): PatchValidationResult;
isGhostElement(element: ExcalidrawElement): boolean;
approveGhostProposal(stores: ExcalidrawYStores, runId: string, options?: MutationOptions): AgentApplyResult;
```

`y-excalidraw-agent`:

```ts
startAgentRun(stores: ExcalidrawYStores, input: StartAgentRunInput): AgentRunState;
updateAgentRunPresence(
  stores: ExcalidrawYStores,
  runId: string,
  presence: AgentRunPresence,
  options?: MutationOptions,
): void;
publishVerifiedSceneProposal(
  stores: ExcalidrawYStores,
  input: {
    runId: string;
    baseScene: ExcalidrawScene;
    finalScene: ExcalidrawScene;
    origin?: unknown;
  },
): AgentApplyResult;
publishExcalidrawFileProposal(
  stores: ExcalidrawYStores,
  input: {
    runId: string;
    baseScene: ExcalidrawScene;
    finalPath: string;
    origin?: unknown;
  },
): Promise<AgentApplyResult>;
approveAgentProposal(stores: ExcalidrawYStores, runId: string, options?: MutationOptions): AgentApplyResult;
rejectAgentProposal(stores: ExcalidrawYStores, runId: string, reason?: string, options?: MutationOptions): void;
```

## Success criteria

- agent開始時に `agentRuns[runId]` がYjsへ書かれ、Web UIがobserveできる。
- agentが配置予定領域や対象要素を持つ場合、`agentRuns[runId].presence` としてYjsへ書ける。
- browserはagent状態をExcalidraw `Footer` に表示できる。
- agentは作業中に `elements` を変更しない。
- apply時に `baseScene`, `finalScene`, `currentScene` からagent patchを作れる。
- agent patchはApprove前に `agentProposals` へ入り、ghost属性付き要素として `elements` に挿入される。
- browserはghost要素を通常要素と区別して表示できる。
- 通常の `readScene()`、export、base/final/current diffではghost要素を除外できる。
- Reject時はghost要素だけを削除し、通常要素を変更しない。
- Approve時はcurrent sceneに対して再検証し、衝突がなければghost要素を通常要素へ昇格、または既存要素へ置き換えられる。
- 別要素のhuman変更を保持したままapproved agent patchを適用できる。
- 同一要素衝突は自動mergeせず `conflicted` としてreportできる。
- `bulkDelete` はY.Array物理順に依存せず、idから実indexを引いて安全に削除する。
- browserはagent updateを受けてもhumanのpointer down中操作を消さない。
