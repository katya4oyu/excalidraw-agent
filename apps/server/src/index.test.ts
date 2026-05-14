import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCollabServer } from "./collab.ts";
import { createApp } from "./index.ts";
import { AppDatabase } from "./db.ts";

describe("server status API", () => {
  test("returns the Codex status provider response", async () => {
    const db = new AppDatabase(":memory:");
    const app = createApp({
      agents: {
        ensureWorker() {
          throw new Error("unexpected worker start");
        },
      } as never,
      codexStatusProvider: async () => ({
        status: "available",
        authMethod: "chatgpt",
        message: "Logged in with ChatGPT",
      }),
      db,
      hocuspocus: createCollabServer(db, {
        ensureWorker() {},
        enqueueRun() {
          return true;
        },
        isRunActive() {
          return false;
        },
        markFromDocumentName() {},
        scheduleIdleWorkerStop() {},
        cancelIdleWorkerStop() {},
      }),
    });

    const response = await app.request("/api/codex/status");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "available",
      authMethod: "chatgpt",
      message: "Logged in with ChatGPT",
    });
    db.close();
  });
});
