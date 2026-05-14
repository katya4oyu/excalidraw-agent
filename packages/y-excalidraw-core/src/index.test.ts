import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import {
  appendElements,
  approveAgentProposal,
  createAgentGhostElement,
  isAgentGhostElement,
  readAgentFooterState,
  rejectAgentProposal,
  summarizeAgentFooterState,
} from "./index.ts";

describe("agent ghost elements", () => {
  test("appends ghost elements with valid fractional order keys", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");

    appendElements({ elements }, [
      { id: "ghost-1", type: "rectangle" },
      { id: "ghost-2", type: "rectangle" },
    ]);

    assert.deepEqual(elements.toArray().map((item) => item.get("pos")), ["a0", "a1"]);
  });

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
    assert.equal(element.opacity, 48);
    assert.equal(element.strokeColor, "#000000");
    assert.equal(element.strokeStyle, undefined);
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
        baseRevision: undefined,
        baseElementSnapshot: undefined,
        originalStyle: {
          opacity: 100,
          strokeColor: "#000000",
        },
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

  test("approves add proposals by materializing ghost elements", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle", opacity: 100, locked: false, strokeColor: "#000000" },
      { runId: "run-1", operation: "add", finalElementId: "shape-1", createdAt: 123 },
    );

    appendElements({ elements }, [ghost]);
    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(approveAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), true);

    const [item] = elements.toArray();
    const element = item?.get("el") as Record<string, unknown>;
    assert.equal(element.id, "shape-1");
    assert.equal(element.opacity, 100);
    assert.equal(element.strokeColor, "#000000");
    assert.equal(element.locked, false);
    assert.equal(isAgentGhostElement(element), false);
    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "applied");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "approved");
  });

  test("conflicts add proposals when final element id already exists", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle" },
      { runId: "run-1", operation: "add", finalElementId: "shape-1", createdAt: 123 },
    );

    appendElements({ elements }, [
      { id: "shape-1", type: "rectangle", version: 1 },
      ghost,
    ]);
    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(approveAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), false);

    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "conflicted");
    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).conflictReason, "final_element_id_exists");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "conflicted");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).conflictReason, "final_element_id_exists");
    assert.equal(isAgentGhostElement(elements.toArray()[1]?.get("el")), true);
  });

  test("marks unsupported update proposals as conflicted", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle" },
      { runId: "run-1", operation: "update", targetElementId: "shape-1", createdAt: 123 },
    );

    appendElements({ elements }, [ghost]);
    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(approveAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), false);

    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "conflicted");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "conflicted");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).conflictReason, "unsupported_operation");
  });

  test("marks proposals stale when base element snapshot no longer matches", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-2", type: "rectangle" },
      {
        runId: "run-1",
        operation: "add",
        finalElementId: "shape-2",
        baseElementSnapshot: { id: "shape-1", version: 1, versionNonce: 111 },
        createdAt: 123,
      },
    );

    appendElements({ elements }, [
      { id: "shape-1", type: "rectangle", version: 2, versionNonce: 222 },
      ghost,
    ]);
    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(approveAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), false);

    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "conflicted");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "stale");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).staleAt, 456);
  });

  test("rejects proposals by deleting ghost elements", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");
    const ghost = createAgentGhostElement(
      { id: "shape-1", type: "rectangle" },
      { runId: "run-1", operation: "add", finalElementId: "shape-1", createdAt: 123 },
    );

    appendElements({ elements }, [ghost]);
    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(rejectAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), true);

    const [item] = elements.toArray();
    const element = item?.get("el") as Record<string, unknown>;
    assert.equal(element.isDeleted, true);
    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "rejected");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "rejected");
  });

  test("rejects proposals even when their ghost elements are already gone", () => {
    const ydoc = new Y.Doc();
    const elements = ydoc.getArray<Y.Map<unknown>>("elements");
    const agentRuns = ydoc.getMap("agentRuns");
    const agentProposals = ydoc.getMap("agentProposals");

    agentRuns.set("run-1", { status: "proposed" });
    agentProposals.set("run-1", { status: "proposed", runId: "run-1", proposalId: "run-1" });

    assert.equal(rejectAgentProposal({ elements, agentRuns, agentProposals }, "run-1", 456), true);

    assert.equal((agentRuns.get("run-1") as Record<string, unknown>).status, "rejected");
    assert.equal((agentProposals.get("run-1") as Record<string, unknown>).status, "rejected");
  });
});
