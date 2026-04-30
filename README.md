# Excalidraw Agent

Excalidraw を人間と Codex Agent が同じ Yjs document 上で共同編集するための実験プロジェクトです。

同期基盤は Hocuspocus/Yjs、Web UI は React + React Router、API server は Hono、Agent 実行は `@openai/codex-sdk` を使います。Codex は Excalidraw 用の skill を読み、作業用 `.excalidraw` ファイルを作ってから、検証済みの内容を Yjs 側へ反映する想定です。

## 構成

```text
apps/
  web/       React + Vite + Excalidraw UI
  server/    Hono REST API + Hocuspocus + SQLite + worker supervisor
  worker/    Codex SDK runner
packages/
  shared/    共通型とYjs helper
```

Codex 用テンプレートは worker が所有します。

```text
apps/worker/templates/codex/
  AGENTS.md
  .agents/skills/excalidraw-skill/
```

worker 実行時には、ファイルIDごとの作業スペースがホームディレクトリ配下に作られます。

```text
~/.excalidraw-agent/{fileId}/
  AGENTS.md
  .agents/skills/excalidraw-skill -> repo/apps/worker/templates/codex/.agents/skills/excalidraw-skill
```

Codex SDK の `workingDirectory` はこの `~/.excalidraw-agent/{fileId}` です。`AGENTS.md` と skill のコピー/リンクは、Codex 初期化前に完了します。

## Tooling

Node と pnpm は mise で固定しています。

```bash
mise trust
mise install
mise run install
```

現在の指定:

```text
node 25.9.0
pnpm 10.30.3
```

## Development

server:

```bash
mise run server
```

web:

```bash
mise run web
```

デフォルトでは:

```text
server http://127.0.0.1:8787
web    http://127.0.0.1:5173
ws     ws://127.0.0.1:8787/collab
```

Portless でポート番号なしの `.localhost` URL を使う場合:

```bash
mise run portless:server
mise run portless:web
```

この場合のURL:

```text
server https://api.excalidraw-agent.localhost
web    https://excalidraw-agent.localhost
ws     wss://excalidraw-agent.localhost/collab
```

Portless は初回起動時にローカルCAやhosts設定を行うことがあります。`mise run portless:web` は `pnpm dlx portless get api.excalidraw-agent` の結果を `VITE_SERVER_URL` に渡し、web の Vite proxy から server へ接続します。HTTPS の Portless URL でも Vite proxy が自己署名証明書で落ちないよう、開発時 proxy は `secure: false` にしています。

LAN へ公開する場合は、server と web の Portless task を起動したうえで、別ターミナルで LAN proxy を起動します。

```bash
PORTLESS_LAN_IP=192.168.201.76 mise run portless:lan
```

LAN proxy を `--no-tls` で起動するため、同じ Wi-Fi の端末からは次のURLを使います。

```text
server http://api.excalidraw-agent.local:1355
web    http://excalidraw-agent.local:1355
ws     ws://excalidraw-agent.local:1355/collab
```

Portless のルーティング先ポートは起動ごとに変わるため、web は `PORT` 環境変数を読んで Vite の待受ポートを合わせます。LAN proxy を止めるときは `mise run portless:stop` を使います。

`POST /api/files` は新規ファイルIDを作り、worker を起動します。worker は Codex SDK を実行するため、Codex CLI/API の認証状態が必要です。

## API

```text
GET  /health
POST /api/files
GET  /api/files/:id
WS   /collab
```

Hocuspocus document name は `file:{fileId}` です。

## Data

server の SQLite は開発用に `apps/server/data/` に作られます。このDBファイルは git 管理対象外です。

Codex が作る `.excalidraw` ファイルも git 管理対象外です。

## Verification

```bash
mise run typecheck
mise run test
```

worker の作業スペース準備だけを確認する場合:

```bash
EXCALIDRAW_AGENT_PREPARE_ONLY=true \
  pnpm --filter @excalidraw-agent/worker dev -- \
  --file-id prep-check
```

この場合、Codex は起動せず、`~/.excalidraw-agent/prep-check` の作成だけを確認できます。
