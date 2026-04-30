# y-excalidraw-binding vendor decision

## 背景

Excalidraw Agent は、人間とagentが同じYjs document上でExcalidraw canvasを共同編集することを目的にしている。Web UIでは人間のpointer操作、selection、undo/redo、remote collaborator表示が必要であり、agent側では検証済みの図面変更をYjs documentへ反映する必要がある。

このため、Excalidraw UIとYjsをつなぐbindingは単なる外部依存ではなく、human + agent共同編集の同期仕様を管理する境界になる。`@excalidraw-agent/y-excalidraw-binding` はOSSを自作扱いするためではなく、このプロジェクトの同期要件に合わせて責任を持って管理するためにvendor化する。

## 3案比較

| 比較軸 | `RahulBadenkal/y-excalidraw` 本家 | `mizuka-wu/y-excalidraw` fork | full scratch / project-native binding |
| --- | --- | --- | --- |
| Excalidraw 0.18対応 | peer dependencyは0.17系。0.18対応をこちらで確認、更新する必要がある。 | 0.18 peer対応済み。現行webの依存に近い。 | 最初から0.18前提で設計できる。 |
| 既存webとの互換性 | 現行webはmizuka forkを使っているため差し戻しの検証が必要。 | 現行webが既に `@mizuka-wu/y-excalidraw` を参照しているため移行リスクが小さい。 | 既存webとのAPI互換を自分たちで作る必要がある。 |
| down中remote update耐性 | 描画中のremote反映でlocal操作が中断されやすい既知の弱点がある。 | `up` 時だけ同期する変更があるが、down中にremote updateが来るとlocal pending操作が消える問題が残る。 | pending local操作、remote merge、flush policyを最初から正しく設計できる。 |
| assets optional管理 | `yAssets` が必須で、外部assets管理には追加変更が必要。 | `yAssets: Y.Map \| null` を許容しており、外部assets管理に向く。 | プロジェクト要件に合わせて設計できる。 |
| 壊れたYjs要素への耐性 | `el` 欠落や空要素に弱い箇所がある。 | guard/filterが追加され、render crashを避けやすい。 | validationとrepair policyを明確にできる。 |
| bulk delete / move / order handling | fractional-indexingの基本設計はあるが、bulk deleteなど実用上の修正を再取り込みする必要がある。 | bulk delete修正、`generateKeyBetween` fallbackなど実用修正が入っている。ただしfallbackやorder仕様は再確認が必要。 | agent向けのpos/order/move/delete APIを最初から統一できる。 |
| agent向けYjs mutation APIとの相性 | 基本構造は利用できるが、agent用APIとしては未整理。 | 初期ベースとしては近いが、order/pos生成とmutation helperをshared化する必要がある。 | 最も相性は良い。web/agent/serverの共通mutation layerを中心にできる。 |
| OSS attribution / maintenance cost | upstreamが明快で礼儀としては最も整理しやすいが、実用修正の再適用コストが高い。 | fork of forkになるため、本家由来とmizuka由来の両方を明記する必要がある。実装開始コストは低い。 | OSS由来の複雑さは減るが、Excalidraw細部、awareness、undo/redo、assets対応を作る初期コストが高い。 |

## 結論

初期ベースには `mizuka-wu/y-excalidraw` forkを使い、`@excalidraw-agent/y-excalidraw-binding` としてproject-localに管理する。

本家 `RahulBadenkal/y-excalidraw` はOSS由来として最も明快だが、Excalidraw 0.18対応、optional assets、壊れたYjs要素への耐性、bulk deleteなど、現行webで必要な実用修正を再取り込みする負担が大きい。

`mizuka-wu/y-excalidraw` forkは現行webに近く、0.18対応やrobustness fixesが既に入っている。一方で、`up` 時だけ同期する処理はこのプロジェクトのhuman + agent共同編集要件には不十分であり、local pending操作とremote updateのmergeを再設計する必要がある。

フルスクラッチは将来の理想形に近いが、初期実装コストとExcalidraw固有挙動への対応が重い。まずはmizuka forkの実用修正を取り込み、同期コアを段階的にこのプロジェクト向けへ置き換える。

由来は次のように明記する。

```md
This package is a project-local fork of RahulBadenkal/y-excalidraw.
It incorporates selected changes from mizuka-wu/y-excalidraw, including
Excalidraw 0.18 compatibility and robustness fixes.
Original license: MIT.
```

## Vendor scope

取り込むもの:

- Excalidraw/Yjs bindingの外側API
- awareness/collaborator同期
- optional assets対応
- Excalidraw 0.18 peer対応
- robustness fixes

見直すもの:

- `up` 時だけ同期する処理
- local pending操作とremote updateのmerge
- `updateScene` によるonChange再同期ガード
- `lastKnownElements` の責務
- order/pos生成のshared化

明示的に今すぐ対象外:

- Excalidraw elementのkey単位CRDT化
- 完全な同一要素同時編集merge
- binding以外のagent描画品質ロジック

## 仕様方針

`y-excalidraw-binding` はWeb UI用bindingとして、人間のExcalidraw操作をYjsへ反映し、remote Yjs更新をExcalidraw sceneへ反映する責務を持つ。agentが直接 `ExcalidrawBinding` を使うことは前提にしない。

agent/server向けには、同じYjs document schemaを扱うmutation helperを別途shared化する。特に `elements` の `pos` 生成、append、update、delete、move、sort順序はWeb bindingとagentで同じ仕様に揃える。

同一要素の同時編集は、当面は要素単位のlast-writer寄り挙動として扱う。別要素の同時編集と、down中のlocal pending操作がremote updateで消えないことを優先する。key単位CRDT化はこのvendor化の初期範囲には含めない。

## 確認項目

- `packages/y-excalidraw-binding/docs/vendor-decision.md` が存在する。
- `packages/y-excalidraw-binding/docs/README.md` からこの文書へリンクされている。
- vendor package作成後、package READMEからこの文書へリンクする。
- vendor package作成後、`pnpm typecheck` とwebのtypecheckを通す。
