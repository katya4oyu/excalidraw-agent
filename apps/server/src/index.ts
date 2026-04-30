import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocketLike } from "@hocuspocus/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as Y from "yjs";
import {
  createExcalidrawYMap,
  createFileId,
  getExcalidrawAgentMetadata,
  toDocumentName,
  type CreateFileResponse,
  type ExcalidrawDocumentData,
  type ImportFileRequest,
  type ImportFileResponse,
} from "@excalidraw-agent/shared";
import { AgentSupervisor } from "./agent";
import { createCollabServer } from "./collab";
import { AppDatabase } from "./db";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`;

const db = new AppDatabase();
const agents = new AgentSupervisor(db, publicBaseUrl);
const hocuspocus = createCollabServer(db, agents);
type HocuspocusClientConnection = ReturnType<typeof hocuspocus.handleConnection>;

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use(
  "*",
  cors({
    origin: (origin) => origin,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    credentials: true,
  }),
);

app.get("/health", (c) => {
  return c.json({ ok: true });
});

app.post("/api/files", (c) => {
  const id = createFileId();
  const documentName = toDocumentName(id);
  db.createFile(id, documentName);
  agents.start(id);

  return c.json<CreateFileResponse>({ id }, 201);
});

app.post("/api/files/import", async (c) => {
  const body = await c.req.json().catch(() => null) as ImportFileRequest | null;
  if (!body || !isRecord(body.document)) {
    return c.json({ error: "document is required" }, 400);
  }

  const metadata = getExcalidrawAgentMetadata(body.document);
  const requestedFileId = typeof body.fileId === "string" && body.fileId.trim()
    ? body.fileId.trim()
    : metadata?.fileId;

  if (requestedFileId) {
    const existing = db.getFile(requestedFileId);
    if (existing) {
      return c.json<ImportFileResponse>({
        id: existing.id,
        documentName: existing.documentName,
        created: false,
        imported: false,
      });
    }
  }

  const id = requestedFileId ?? createFileId();
  const documentName = toDocumentName(id);
  db.createFile(id, documentName, "verified");
  storeExcalidrawDocument(documentName, body.document);

  return c.json<ImportFileResponse>({
    id,
    documentName,
    created: true,
    imported: true,
  }, 201);
});

app.post("/api/files/:id/agent-runs", async (c) => {
  const fileId = c.req.param("id");
  const file = db.getFile(fileId);
  if (!file) {
    return c.json({ error: "file not found" }, 404);
  }

  const body = await c.req.json().catch(() => null) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  const started = agents.start(file.id, { prompt });
  return c.json({
    fileId: file.id,
    started,
    agentStatus: "running",
  }, started ? 201 : 202);
});

app.get("/api/files/:id", (c) => {
  const file = db.getFile(c.req.param("id"));

  if (!file) {
    return c.json({ error: "file not found" }, 404);
  }

  return c.json(file);
});

app.get(
  "/collab",
  upgradeWebSocket((c) => {
    let clientConnection: HocuspocusClientConnection | undefined;

    return {
      onOpen(_event, ws) {
        ws.raw!.binaryType = "arraybuffer";
        clientConnection = hocuspocus.handleConnection(ws.raw as WebSocketLike, c.req.raw, {});
      },
      async onMessage(event) {
        const data = await toUint8Array(event.data);
        clientConnection?.handleMessage(data);
      },
      onClose() {
        clientConnection?.handleClose();
      },
    };
  }),
);

const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  () => {
    console.log(`Server listening at ${publicBaseUrl}`);
    console.log(`Hocuspocus websocket at ${publicBaseUrl.replace(/^http/, "ws")}/collab`);
  },
);

injectWebSocket(server);

async function toUint8Array(data: string | ArrayBuffer | SharedArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof SharedArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  return new TextEncoder().encode(data);
}

function storeExcalidrawDocument(documentName: `file:${string}`, document: ExcalidrawDocumentData): void {
  const ydoc = new Y.Doc();
  const yElements = ydoc.getArray<Y.Map<unknown>>("elements");
  const yAssets = ydoc.getMap("assets");
  const yAppState = ydoc.getMap("appState");
  const elements = Array.isArray(document.elements) ? document.elements : [];

  yElements.push(
    elements
      .filter(isRecord)
      .map((element, index) => createExcalidrawYMap(element, `${Date.now() + index}:${crypto.randomUUID()}`)),
  );

  if (isRecord(document.files)) {
    for (const [id, file] of Object.entries(document.files)) {
      yAssets.set(id, file);
    }
  }

  if (isRecord(document.appState)) {
    for (const [key, value] of Object.entries(document.appState)) {
      yAppState.set(key, value);
    }
  }

  db.storeDocument(documentName, Y.encodeStateAsUpdate(ydoc));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
