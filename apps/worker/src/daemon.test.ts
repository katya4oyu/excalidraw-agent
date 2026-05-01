import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AgentWorkerResponseMessage } from "@excalidraw-agent/shared";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("daemon prepares a workspace and emits ready", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "excalidraw-agent-worker-"));
  tempRoots.push(workspaceRoot);
  const fileId = `worker-test-${crypto.randomUUID()}`;
  const child = fork(
    new URL("./index.ts", import.meta.url).pathname,
    [
      "--daemon",
      "--file-id",
      fileId,
      "--server-url",
      "http://127.0.0.1:8787",
      "--workspace-root",
      workspaceRoot,
    ],
    {
      env: {
        ...process.env,
        EXCALIDRAW_AGENT_PREPARE_ONLY: "true",
      },
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );

  try {
    const message = await waitForReady(child);
    assert.deepEqual(message, { type: "ready", fileId });
    assert.equal(existsSync(join(workspaceRoot, fileId, "AGENTS.md")), true);
    assert.equal(existsSync(join(workspaceRoot, fileId, ".agents", "skills", "excalidraw-skill", "SKILL.md")), true);
  } finally {
    child.kill();
  }
});

function waitForReady(child: ReturnType<typeof fork>): Promise<AgentWorkerResponseMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for worker ready message"));
    }, 5_000);

    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message as AgentWorkerResponseMessage);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker exited before ready: ${code}`));
    });
  });
}
