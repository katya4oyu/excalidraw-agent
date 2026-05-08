import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { publishGhostDraft, publishGhostProposal, removeGhostDraft } from "./index.ts";

const isLiveElement = (element: unknown): element is Record<string, unknown> =>
  typeof element === "object" &&
  element !== null &&
  !Array.isArray(element) &&
  (element as Record<string, unknown>).isDeleted !== true;

test("publishGhostDraft replaces previous step ghosts without creating a final proposal", () => {
  const ydoc = new Y.Doc();
  const elements = ydoc.getArray<Y.Map<unknown>>("elements");
  const agentRuns = ydoc.getMap("agentRuns");
  const agentProposals = ydoc.getMap("agentProposals");

  const first = publishGhostDraft({ elements, agentRuns }, {
    runId: "run-1",
    stepIndex: 0,
    elements: [{ id: "draft-a", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }],
    createdAt: 1,
  });
  const second = publishGhostDraft({ elements, agentRuns }, {
    runId: "run-1",
    stepIndex: 1,
    elements: [{ id: "draft-b", type: "ellipse", x: 20, y: 0, width: 10, height: 10 }],
    createdAt: 2,
  });

  const liveElements = elements.toArray()
    .map((item) => item.get("el"))
    .filter(isLiveElement);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(liveElements.length, 1);
  assert.equal(liveElements[0]?.id, "ghost:run-1:draft-b");
  assert.equal(agentProposals.size, 0);
  assert.equal((agentRuns.get("run-1") as Record<string, unknown>).phase, "drafting");
});

test("removeGhostDraft clears draft ghosts while final proposals remain", () => {
  const ydoc = new Y.Doc();
  const elements = ydoc.getArray<Y.Map<unknown>>("elements");
  const agentRuns = ydoc.getMap("agentRuns");
  const agentProposals = ydoc.getMap("agentProposals");

  publishGhostDraft({ elements, agentRuns }, {
    runId: "run-1",
    stepIndex: 0,
    elements: [{ id: "draft", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }],
    createdAt: 1,
  });
  publishGhostProposal({ elements, agentRuns, agentProposals }, {
    runId: "run-1",
    elements: [{ id: "final", type: "ellipse", x: 20, y: 0, width: 10, height: 10 }],
    operation: "add",
    createdAt: 2,
  });

  assert.equal(removeGhostDraft({ elements, agentRuns }, "run-1", 3), 1);
  const liveIds = elements.toArray()
    .map((item) => item.get("el"))
    .filter(isLiveElement)
    .map((element) => element.id);
  assert.deepEqual(liveIds, ["ghost:run-1:final"]);
});
