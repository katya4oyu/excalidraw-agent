import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRunQueueRequest, AgentWorkerRequestMessage, FileId } from "@excalidraw-agent/shared";
import { AgentSupervisor } from "./agent.ts";

describe("AgentSupervisor idle worker lifecycle", () => {
  test("stops an idle worker after the grace period", async () => {
    const supervisor = new AgentSupervisor(new FakeAgentDatabase(), "http://example.test", 1);
    const process = new FakeWorkerProcess();
    addWorker(supervisor, {
      fileId: "file-1",
      ready: true,
      busy: false,
      pending: [],
      process,
    });

    supervisor.scheduleIdleWorkerStop("file-1");
    await wait(5);

    assert.equal(process.killed, true);
    assert.equal(process.disconnected, true);
    assert.deepEqual(process.sent, [{ type: "shutdown", reason: "idle" }]);
  });

  test("cancels a scheduled idle stop", async () => {
    const supervisor = new AgentSupervisor(new FakeAgentDatabase(), "http://example.test", 1);
    const process = new FakeWorkerProcess();
    addWorker(supervisor, {
      fileId: "file-1",
      ready: true,
      busy: false,
      pending: [],
      process,
    });

    supervisor.scheduleIdleWorkerStop("file-1");
    supervisor.cancelIdleWorkerStop("file-1");
    await wait(5);

    assert.equal(process.killed, false);
    assert.deepEqual(process.sent, []);
  });

  test("does not stop workers with pending runs when the grace period elapses", async () => {
    const supervisor = new AgentSupervisor(new FakeAgentDatabase(), "http://example.test", 1);
    const process = new FakeWorkerProcess();
    const worker = addWorker(supervisor, {
      fileId: "file-1",
      ready: true,
      busy: false,
      pending: [createRunRequest("run-1")],
      process,
    });

    supervisor.scheduleIdleWorkerStop("file-1");
    await wait(5);

    assert.equal(process.killed, false);

    worker.pending = [];
    supervisor["flush"](worker as never);

    assert.equal(process.killed, true);
  });
});

class FakeAgentDatabase {
  updateAgentStatus(): void {}
}

class FakeWorkerProcess {
  connected = true;
  disconnected = false;
  killed = false;
  readonly sent: AgentWorkerRequestMessage[] = [];

  send(message: AgentWorkerRequestMessage): void {
    this.sent.push(message);
  }

  disconnect(): void {
    this.connected = false;
    this.disconnected = true;
  }

  kill(): void {
    this.killed = true;
  }
}

function addWorker(
  supervisor: AgentSupervisor,
  worker: {
    fileId: FileId;
    ready: boolean;
    busy: boolean;
    pending: AgentRunQueueRequest[];
    process: FakeWorkerProcess;
  },
): typeof worker {
  supervisor["workers"].set(worker.fileId, worker as never);
  return worker;
}

function createRunRequest(runId: string): AgentRunQueueRequest {
  return {
    fileId: "file-1",
    prompt: "run",
    requestId: `request-${runId}`,
    runId,
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
