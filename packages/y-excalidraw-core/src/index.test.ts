import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import {
  appendElements,
  createAgentGhostElement,
  isAgentGhostElement,
  readAgentFooterState,
  summarizeAgentFooterState,
} from "./index.ts";

describe("agent ghost elements", () => {
  test("marks elements as agent ghosts with operation styling", () => {
    const element = createAgentGhostElement(
      {
        id: "shape-1",
        type: "rectangle",
        strokeColor: "#000000",
        opacity: 100,
      },
      {
        runId: "run-1",
        operation: "add",
        finalElementId: "shape-1",
        createdAt: 123,
      },
    );

    assert.equal(element.id, "ghost:run-1:shape-1");
    assert.equal(element.opacity, 35);
    assert.equal(element.strokeColor, "#1e88e5");
    assert.equal(element.strokeStyle, "dashed");
    assert.equal(element.locked, true);
    assert.deepEqual(element.customData, {
      excalidrawAgent: {
        schemaVersion: 1,
        kind: "ghost",
        runId: "run-1",
        proposalId: "run-1",
        operation: "add",
        targetElementId: undefined,
        finalElementId: "shape-1",
        createdAt: 123,
      },
    });
    assert.equal(isAgentGhostElement(element), true);
  });

  test("summarizes footer state from runs proposals and ghost elements", () => {
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle" },
      { runId: "run-1", operation: "update", targetElementId: "shape-1", createdAt: 123 },
    );

    assert.deepEqual(
      summarizeAgentFooterState({
        runs: [{ status: "running" }],
        proposals: [{ status: "proposed" }],
        elements: [ghost, { id: "normal" }],
      }),
      {
        runStatus: "proposed",
        activeRunCount: 1,
        proposedCount: 1,
        ghostElementCount: 1,
      },
    );
  });

  test("reads footer state from Yjs stores", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle" },
      { runId: "run-1", operation: "add", finalElementId: "shape-1", createdAt: 123 },
    );

    appendElements({ elements }, [ghost]);
    agentRuns.set("run-1", { status: "running" });
    agentProposals.set("run-1", { status: "proposed" });

    assert.deepEqual(readAgentFooterState({ elements, agentRuns, agentProposals }), {
      runStatus: "proposed",
      activeRunCount: 1,
      proposedCount: 1,
      ghostElementCount: 1,
    });
  });
});
