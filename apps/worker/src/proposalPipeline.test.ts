import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildPrompt,
  derivePatchFromScenes,
  derivedPatchFileName,
  finalArtifactFileName,
  readFinalProposal,
  type RunSnapshot,
} from "./proposalPipeline.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("buildPrompt requires the run final.excalidraw artifact", () => {
  const prompt = buildPrompt(
    {
      fileId: "file-1",
      serverUrl: "http://127.0.0.1:8787",
      workspaceRoot: "/tmp/workspaces",
      workspaceTemplate: "/tmp/template",
    },
    "図を更新して",
    {
      fileId: "file-1",
      requestId: "request-1",
      runId: "run-1",
      prompt: "図を更新して",
    },
    "/tmp/workspaces/file-1/runs/run-1/base-scene.json",
  );

  assert.match(prompt, /成果物: runs\/run-1\/final\.excalidraw/);
  assert.match(prompt, /必ず runs\/run-1\/final\.excalidraw に最終 Excalidraw scene を保存/);
});

test("derivePatchFromScenes emits add operations for new visible final elements", () => {
  const patch = derivePatchFromScenes({
    baseRevision: "scene:base",
    now: 123,
    baseScene: {
      elements: [
        { id: "existing", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: false },
      ],
    },
    finalScene: {
      elements: [
        { id: "existing", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: false },
        { id: "new-shape", type: "ellipse", x: 20, y: 20, width: 30, height: 30, isDeleted: false },
        { id: "deleted-new", type: "rectangle", isDeleted: true },
      ],
    },
  });

  assert.deepEqual(patch, {
    schemaVersion: 1,
    baseRevision: "scene:base",
    operations: [
      {
        type: "add",
        element: { id: "new-shape", type: "ellipse", x: 20, y: 20, width: 30, height: 30, isDeleted: false },
      },
    ],
    unsupportedCount: 0,
    createdAt: 123,
  });
});

test("derivePatchFromScenes records unsupported update, move, and delete metadata", () => {
  const patch = derivePatchFromScenes({
    baseRevision: "scene:base",
    now: 456,
    baseScene: {
      elements: [
        { id: "updated", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
        { id: "moved", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
        { id: "removed", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      ],
    },
    finalScene: {
      elements: [
        { id: "updated", type: "rectangle", x: 0, y: 0, width: 20, height: 10 },
        { id: "moved", type: "rectangle", x: 12, y: 0, width: 10, height: 10 },
      ],
    },
  });

  assert.deepEqual(patch.operations, [
    { type: "unsupported", reason: "update", elementId: "updated" },
    { type: "unsupported", reason: "move", elementId: "moved" },
    { type: "unsupported", reason: "delete", elementId: "removed" },
  ]);
  assert.equal(patch.unsupportedCount, 3);
});

test("readFinalProposal loads final.excalidraw and writes derived.patch.json", () => {
  const root = mkdtempSync(join(tmpdir(), "excalidraw-agent-pipeline-"));
  tempRoots.push(root);
  const runDirectory = join(root, "runs", "run-1");
  const snapshotPath = join(runDirectory, "base-scene.json");
  const snapshot: RunSnapshot = {
    baseRevision: "scene:base",
    runDirectory,
    snapshotPath,
  };
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    runId: "run-1",
    baseRevision: "scene:base",
    elements: [{ id: "base", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }],
  }));
  writeFileSync(join(runDirectory, finalArtifactFileName), JSON.stringify({
    type: "excalidraw",
    elements: [
      { id: "base", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      { id: "added", type: "text", x: 12, y: 0, width: 80, height: 24, text: "hello" },
    ],
  }));

  const result = readFinalProposal(snapshot);
  assert.equal(result.status, "loaded");
  assert.deepEqual(result.status === "loaded" ? result.proposal.proposedElements.map((element) => element.id) : [], [
    "added",
  ]);
  const derivedPatchPath = join(runDirectory, derivedPatchFileName);
  assert.equal(existsSync(derivedPatchPath), true);
  assert.equal(JSON.parse(readFileSync(derivedPatchPath, "utf8")).operations[0].type, "add");
});

test("readFinalProposal reports missing final artifact without creating a patch", () => {
  const root = mkdtempSync(join(tmpdir(), "excalidraw-agent-pipeline-"));
  tempRoots.push(root);
  const runDirectory = join(root, "runs", "run-1");
  const snapshot: RunSnapshot = {
    baseRevision: "scene:base",
    runDirectory,
    snapshotPath: join(runDirectory, "base-scene.json"),
  };

  const result = readFinalProposal(snapshot);
  assert.equal(result.status, "missing");
  assert.equal(existsSync(join(runDirectory, derivedPatchFileName)), false);
});
