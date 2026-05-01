# Documentation

このディレクトリを、このリポジトリの設計ドキュメントの正本置き場にする。

## 読む順番

1. [Concept](./concept.md)
2. [Architecture](./architecture.md)
3. [y-excalidraw package architecture](./y-excalidraw/package-architecture.md)
4. [Agent rebase apply design](./y-excalidraw/agent-rebase-apply.md)
5. [y-excalidraw vendor decision](./y-excalidraw/vendor-decision.md)

## 配置方針

- プロダクト全体の目的、境界、設計判断は `docs/` に置く。
- package 配下には、その package の利用者向け README や API 参照だけを置く。
- 特定 package に関係する設計判断でも、複数 package や実行時フローに影響するものは `docs/{topic}/` に置く。
- 既存実装と目標設計がずれる場合は、完了済みとして書かず、未実装または known gap として明示する。
