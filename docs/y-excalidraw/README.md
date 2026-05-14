# y-excalidraw Design Notes

Excalidraw と Yjs の同期境界、および agent proposal apply の設計判断をまとめる。

- [Package architecture](./package-architecture.md)
- [Agent worker lifecycle](./agent-worker-lifecycle.md)
- [Agent rebase apply](./agent-rebase-apply.md)
- [Vendor decision](./vendor-decision.md)
- [Excalidraw design system moodboard](../../apps/web/docs/assets/excalidraw-design-system-moodboard.png)

これらは `packages/y-excalidraw-*` の利用者向け API 文書ではなく、リポジトリ全体の設計判断である。そのため package 配下ではなく、ルート `docs/` 配下で管理する。
