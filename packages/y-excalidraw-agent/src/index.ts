import {
  appendElements,
  createAgentGhostElement,
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
    createdAt,
  });

  return ghostElementIds;
};

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
