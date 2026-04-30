import {
  appendElements,
  createAgentGhostElement,
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
  const ghostElements = input.elements.map((element) =>
    createAgentGhostElement(element, {
      runId: input.runId,
      proposalId,
      operation: input.operation,
      finalElementId: typeof element.id === "string" ? element.id : undefined,
      createdAt,
    }),
  );
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
    createdAt,
  });

  return ghostElementIds;
};
