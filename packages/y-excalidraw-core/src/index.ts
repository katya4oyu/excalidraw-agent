import * as Y from "yjs";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "proposed"
  | "applying"
  | "applied"
  | "rejected"
  | "failed"
  | "conflicted";
export type AgentProposalStatus = "proposed" | "approved" | "rejected" | "stale";
export type AgentGhostOperation = "add" | "update" | "delete" | "move";

export interface ExcalidrawYStores {
  elements: Y.Array<Y.Map<unknown>>;
  assets?: Y.Map<unknown>;
  agentRuns?: Y.Map<unknown>;
  agentProposals?: Y.Map<unknown>;
}

export interface ExcalidrawAgentGhostElementMetadata {
  schemaVersion: 1;
  kind: "ghost";
  runId: string;
  proposalId: string;
  operation: AgentGhostOperation;
  targetElementId?: string;
  finalElementId?: string;
  createdAt: number;
}

export interface AgentGhostElementOptions {
  runId: string;
  proposalId?: string;
  operation: AgentGhostOperation;
  targetElementId?: string;
  finalElementId?: string;
  createdAt?: number;
}

export interface AgentFooterState {
  runStatus: AgentRunStatus | "idle";
  activeRunCount: number;
  proposedCount: number;
  ghostElementCount: number;
}

export const agentGhostStyleByOperation = {
  add: {
    opacity: 35,
    strokeColor: "#1e88e5",
    backgroundColor: "transparent",
    strokeStyle: "dashed",
    locked: true,
  },
  update: {
    opacity: 35,
    strokeColor: "#1e88e5",
    backgroundColor: "transparent",
    strokeStyle: "dashed",
    locked: true,
  },
  delete: {
    opacity: 30,
    strokeColor: "#d32f2f",
    backgroundColor: "transparent",
    strokeStyle: "dashed",
    locked: true,
  },
  move: {
    opacity: 35,
    strokeColor: "#1e88e5",
    backgroundColor: "transparent",
    strokeStyle: "dashed",
    locked: true,
  },
} as const satisfies Record<AgentGhostOperation, Record<string, unknown>>;

export const createExcalidrawYMap = (
  element: Record<string, unknown>,
  pos = getElementOrderKey(element) ?? generateKeyBetween(null, null),
): Y.Map<unknown> => {
  const item = new Y.Map<unknown>();
  item.set("el", element);
  item.set("pos", pos);
  return item;
};

export const createAgentGhostMetadata = ({
  runId,
  proposalId = runId,
  operation,
  targetElementId,
  finalElementId,
  createdAt = Date.now(),
}: AgentGhostElementOptions): ExcalidrawAgentGhostElementMetadata => {
  return {
    schemaVersion: 1,
    kind: "ghost",
    runId,
    proposalId,
    operation,
    targetElementId,
    finalElementId,
    createdAt,
  };
};

export const createAgentGhostElement = (
  element: Record<string, unknown>,
  options: AgentGhostElementOptions,
): Record<string, unknown> => {
  const metadata = createAgentGhostMetadata(options);

  return {
    ...element,
    id: `ghost:${metadata.runId}:${String(element.id ?? crypto.randomUUID())}`,
    ...agentGhostStyleByOperation[metadata.operation],
    customData: {
      ...(isRecord(element.customData) ? element.customData : {}),
      excalidrawAgent: metadata,
    },
  };
};

export const appendElements = (
  stores: Pick<ExcalidrawYStores, "elements">,
  elements: Record<string, unknown>[],
): void => {
  const positions = generateNKeysBetween(getLastElementOrderKey(stores.elements), null, elements.length);
  stores.elements.push(elements.map((element, index) =>
    createExcalidrawYMap(element, getElementOrderKey(element) ?? positions[index]),
  ));
};

export const isAgentGhostElement = (element: unknown): boolean => {
  if (!isRecord(element)) {
    return false;
  }

  const customData = element.customData;
  if (!isRecord(customData)) {
    return false;
  }

  const metadata = customData.excalidrawAgent;
  return (
    isRecord(metadata) &&
    metadata.schemaVersion === 1 &&
    metadata.kind === "ghost" &&
    typeof metadata.runId === "string" &&
    typeof metadata.proposalId === "string" &&
    isAgentGhostOperation(metadata.operation) &&
    typeof metadata.createdAt === "number"
  );
};

export const summarizeAgentFooterState = (
  input: {
    runs?: unknown[];
    proposals?: unknown[];
    elements?: unknown[];
  },
): AgentFooterState => {
  const runStatuses = (input.runs ?? [])
    .map((run) => (isRecord(run) ? run.status : undefined))
    .filter(isAgentRunStatus);
  const proposalStatuses = (input.proposals ?? [])
    .map((proposal) => (isRecord(proposal) ? proposal.status : undefined))
    .filter(isAgentProposalStatus);
  const activeRunCount = runStatuses.filter((status) => status === "queued" || status === "running").length;
  const proposedCount = proposalStatuses.filter((status) => status === "proposed").length;
  const ghostElementCount = (input.elements ?? []).filter(isAgentGhostElement).length;

  return {
    runStatus: chooseFooterRunStatus(runStatuses, proposedCount, ghostElementCount),
    activeRunCount,
    proposedCount,
    ghostElementCount,
  };
};

export const readAgentFooterState = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
): AgentFooterState => {
  return summarizeAgentFooterState({
    runs: Object.values(stores.agentRuns?.toJSON() ?? {}),
    proposals: Object.values(stores.agentProposals?.toJSON() ?? {}),
    elements: stores.elements.toArray().map((item) => item.get("el")),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const getElementOrderKey = (element: Record<string, unknown>): string | null => {
  return isValidElementOrderKey(element.index) ? element.index : null;
};

const getLastElementOrderKey = (elements: Y.Array<Y.Map<unknown>>): string | null => {
  const keys = elements
    .toArray()
    .map((item) => item.get("pos"))
    .filter(isValidElementOrderKey)
    .sort();
  return keys.at(-1) ?? null;
};

const isValidElementOrderKey = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
};

const isAgentGhostOperation = (value: unknown): value is AgentGhostOperation => {
  return value === "add" || value === "update" || value === "delete" || value === "move";
};

const isAgentRunStatus = (value: unknown): value is AgentRunStatus => {
  return (
    value === "queued" ||
    value === "running" ||
    value === "proposed" ||
    value === "applying" ||
    value === "applied" ||
    value === "rejected" ||
    value === "failed" ||
    value === "conflicted"
  );
};

const isAgentProposalStatus = (value: unknown): value is AgentProposalStatus => {
  return value === "proposed" || value === "approved" || value === "rejected" || value === "stale";
};

const chooseFooterRunStatus = (
  statuses: AgentRunStatus[],
  proposedCount: number,
  ghostElementCount: number,
): AgentFooterState["runStatus"] => {
  if (statuses.includes("conflicted")) {
    return "conflicted";
  }
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("applying")) {
    return "applying";
  }
  if (proposedCount > 0 || ghostElementCount > 0 || statuses.includes("proposed")) {
    return "proposed";
  }
  if (statuses.includes("running")) {
    return "running";
  }
  if (statuses.includes("queued")) {
    return "queued";
  }
  if (statuses.includes("applied")) {
    return "applied";
  }
  if (statuses.includes("rejected")) {
    return "rejected";
  }
  return "idle";
};
