import {
  appendElements,
  createAgentGhostElement,
  getAgentGhostMetadata,
  type AgentProposalBaseElementSnapshot,
  type AgentGhostElementOptions,
  type AgentRunStatus,
  type ExcalidrawYStores,
} from "@excalidraw-agent/y-excalidraw-core";

export interface StartAgentRunInput {
  runId: string;
  status?: Extract<AgentRunStatus, "queued" | "running">;
  startedAt?: number;
  message?: string;
}

export interface PublishGhostProposalInput {
  runId: string;
  elements: Record<string, unknown>[];
  operation: AgentGhostElementOptions["operation"];
  proposalId?: string;
  targetElementId?: string;
  baseRevision?: string;
  baseElementSnapshots?: AgentProposalBaseElementSnapshot[];
  baseElements?: Record<string, unknown>[];
  createdAt?: number;
  source?: "codex-final-artifact" | "codex-step-draft" | string;
}

export interface PublishGhostDraftInput {
  runId: string;
  stepIndex: number;
  elements: Record<string, unknown>[];
  baseRevision?: string;
  createdAt?: number;
}

export const startAgentRun = (
  stores: Pick<ExcalidrawYStores, "agentRuns">,
  input: StartAgentRunInput,
): void => {
  stores.agentRuns?.set(input.runId, {
    status: input.status ?? "running",
    startedAt: input.startedAt ?? Date.now(),
    message: input.message,
  });
};

export const publishGhostProposal = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
  input: PublishGhostProposalInput,
): string[] => {
  const proposalId = input.proposalId ?? input.runId;
  const createdAt = input.createdAt ?? Date.now();
  const baseElementSnapshots = input.baseElementSnapshots ?? input.baseElements?.map(createBaseElementSnapshot);
  const ghostElements = input.elements.map((element, index) => {
    const baseElementSnapshot = pickBaseElementSnapshot(baseElementSnapshots, element, index, input.targetElementId);
    return createAgentGhostElement(element, {
      runId: input.runId,
      proposalId,
      operation: input.operation,
      targetElementId: input.targetElementId ?? baseElementSnapshot?.id,
      finalElementId: typeof element.id === "string" ? element.id : undefined,
      baseRevision: input.baseRevision,
      baseElementSnapshot,
      createdAt,
    });
  });
  const ghostElementIds = ghostElements.map((element) => String(element.id));

  appendElements(stores, ghostElements);
  stores.agentRuns?.set(input.runId, {
    ...(stores.agentRuns.get(input.runId) as Record<string, unknown> | undefined),
    status: "proposed",
    proposedAt: createdAt,
  });
  stores.agentProposals?.set(proposalId, {
    status: "proposed",
    runId: input.runId,
    proposalId,
    ghostElementIds,
    baseRevision: input.baseRevision,
    baseElementSnapshots,
    source: input.source ?? "codex-final-artifact",
    createdAt,
  });

  return ghostElementIds;
};

export const publishGhostDraft = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns">,
  input: PublishGhostDraftInput,
): string[] => {
  const proposalId = draftProposalId(input.runId);
  removeAgentGhostsForProposal(stores, proposalId);

  const createdAt = input.createdAt ?? Date.now();
  const ghostElements = input.elements.map((element) =>
    createAgentGhostElement(element, {
      runId: input.runId,
      proposalId,
      operation: "add",
      finalElementId: typeof element.id === "string" ? element.id : undefined,
      baseRevision: input.baseRevision,
      createdAt,
    })
  );
  const ghostElementIds = ghostElements.map((element) => String(element.id));

  appendElements(stores, ghostElements);
  stores.agentRuns?.set(input.runId, {
    ...(stores.agentRuns.get(input.runId) as Record<string, unknown> | undefined),
    phase: "drafting",
    draftStepIndex: input.stepIndex,
    draftGhostElementIds: ghostElementIds,
    updatedAt: createdAt,
  });
  return ghostElementIds;
};

export const removeAgentGhostsForProposal = (
  stores: Pick<ExcalidrawYStores, "elements">,
  proposalId: string,
  now = Date.now(),
): number => {
  let removed = 0;
  for (const item of stores.elements.toArray()) {
    const element = item.get("el");
    const metadata = getAgentGhostMetadata(element);
    if (!metadata || metadata.proposalId !== proposalId || !isRecord(element)) {
      continue;
    }
    item.set("el", {
      ...element,
      isDeleted: true,
      updated: now,
      version: typeof element.version === "number" ? element.version + 1 : 1,
      versionNonce: Math.floor(Math.random() * 1_000_000),
    });
    removed += 1;
  }
  return removed;
};

export const removeGhostDraft = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns">,
  runId: string,
  now = Date.now(),
): number => {
  const removed = removeAgentGhostsForProposal(stores, draftProposalId(runId), now);
  const current = stores.agentRuns?.get(runId);
  if (stores.agentRuns && isRecord(current)) {
    stores.agentRuns.set(runId, {
      ...current,
      draftGhostElementIds: [],
      updatedAt: now,
    });
  }
  return removed;
};

const draftProposalId = (runId: string): string => `draft:${runId}`;

const createBaseElementSnapshot = (element: Record<string, unknown>): AgentProposalBaseElementSnapshot => {
  return {
    id: String(element.id),
    ...(typeof element.version === "number" ? { version: element.version } : {}),
    ...(typeof element.versionNonce === "number" ? { versionNonce: element.versionNonce } : {}),
    ...(typeof element.updated === "number" ? { updated: element.updated } : {}),
    ...(typeof element.isDeleted === "boolean" ? { isDeleted: element.isDeleted } : {}),
    snapshot: element,
  };
};

const pickBaseElementSnapshot = (
  snapshots: AgentProposalBaseElementSnapshot[] | undefined,
  element: Record<string, unknown>,
  index: number,
  targetElementId?: string,
): AgentProposalBaseElementSnapshot | undefined => {
  if (!snapshots || snapshots.length === 0) {
    return undefined;
  }

  const elementId = typeof element.id === "string" ? element.id : undefined;
  return (
    snapshots.find((snapshot) => snapshot.id === targetElementId) ??
    snapshots.find((snapshot) => snapshot.id === elementId) ??
    snapshots[index]
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
