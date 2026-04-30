import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocketLike } from "@hocuspocus/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createFileId, toDocumentName, type CreateFileResponse } from "@excalidraw-agent/shared";
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
