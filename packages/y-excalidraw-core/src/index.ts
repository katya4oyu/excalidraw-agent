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
  originalStyle?: Record<string, unknown>;
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
  metadata.originalStyle = pickOriginalElementStyle(element);

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

export const getAgentGhostMetadata = (
  element: unknown,
): ExcalidrawAgentGhostElementMetadata | null => {
  if (!isAgentGhostElement(element) || !isRecord(element)) {
    return null;
  }

  const customData = element.customData;
  if (!isRecord(customData)) {
    return null;
  }

  const metadata = customData.excalidrawAgent;
  if (!isRecord(metadata)) {
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "ghost",
    runId: metadata.runId as string,
    proposalId: metadata.proposalId as string,
    operation: metadata.operation as AgentGhostOperation,
    ...(typeof metadata.targetElementId === "string" ? { targetElementId: metadata.targetElementId } : {}),
    ...(typeof metadata.finalElementId === "string" ? { finalElementId: metadata.finalElementId } : {}),
    ...(isRecord(metadata.originalStyle) ? { originalStyle: metadata.originalStyle } : {}),
    createdAt: metadata.createdAt as number,
  };
};

export const approveAgentProposal = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
  proposalId: string,
  now = Date.now(),
): boolean => {
  const proposal = stores.agentProposals?.get(proposalId);
  if (!isRecord(proposal) || proposal.status !== "proposed") {
    return false;
  }

  let changed = false;
  stores.elements.doc?.transact(() => {
    for (const item of stores.elements.toArray()) {
      const element = item.get("el");
      const metadata = getAgentGhostMetadata(element);
      if (!metadata || metadata.proposalId !== proposalId || !isRecord(element)) {
        continue;
      }

      if (metadata.operation === "add") {
        item.set("el", materializeAgentGhostElement(element, metadata, now));
        changed = true;
        continue;
      }

      item.set("el", {
        ...element,
        isDeleted: true,
        updated: now,
        version: typeof element.version === "number" ? element.version + 1 : 1,
        versionNonce: Math.floor(Math.random() * 1_000_000),
      });
      changed = true;
    }

    if (!changed) {
      return;
    }

    stores.agentProposals?.set(proposalId, {
      ...proposal,
      status: "approved",
      approvedAt: now,
      updatedAt: now,
    });
    const runId = typeof proposal.runId === "string" ? proposal.runId : proposalId;
    const run = stores.agentRuns?.get(runId);
    stores.agentRuns?.set(runId, {
      ...(isRecord(run) ? run : {}),
      status: "applied",
      appliedAt: now,
      updatedAt: now,
    });
  });

  return changed;
};

export const rejectAgentProposal = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
  proposalId: string,
  now = Date.now(),
): boolean => {
  const proposal = stores.agentProposals?.get(proposalId);
  if (!isRecord(proposal) || proposal.status !== "proposed") {
    return false;
  }

  let changed = false;
  stores.elements.doc?.transact(() => {
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
      changed = true;
    }

    if (!changed) {
      return;
    }

    stores.agentProposals?.set(proposalId, {
      ...proposal,
      status: "rejected",
      rejectedAt: now,
      updatedAt: now,
    });
    const runId = typeof proposal.runId === "string" ? proposal.runId : proposalId;
    const run = stores.agentRuns?.get(runId);
    stores.agentRuns?.set(runId, {
      ...(isRecord(run) ? run : {}),
      status: "rejected",
      rejectedAt: now,
      updatedAt: now,
    });
  });

  return changed;
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

const materializeAgentGhostElement = (
  element: Record<string, unknown>,
  metadata: ExcalidrawAgentGhostElementMetadata,
  now: number,
): Record<string, unknown> => {
  const customData = isRecord(element.customData) ? element.customData : {};
  const { excalidrawAgent: _excalidrawAgent, ...restCustomData } = customData;
  const hasCustomData = Object.keys(restCustomData).length > 0;

  return {
    ...element,
    ...(metadata.originalStyle ?? {}),
    id: metadata.finalElementId ?? stripGhostPrefix(String(element.id ?? crypto.randomUUID())),
    opacity: 100,
    locked: false,
    customData: hasCustomData ? restCustomData : undefined,
    updated: now,
    version: typeof element.version === "number" ? element.version + 1 : 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
  };
};

const stripGhostPrefix = (id: string): string => {
  const parts = id.split(":");
  return parts[0] === "ghost" && parts.length >= 3 ? parts.slice(2).join(":") : id;
};

const originalStyleKeys = [
  "backgroundColor",
  "fillStyle",
  "opacity",
  "roughness",
  "strokeColor",
  "strokeStyle",
  "strokeWidth",
] as const;

const pickOriginalElementStyle = (element: Record<string, unknown>): Record<string, unknown> => {
  const style: Record<string, unknown> = {};
  for (const key of originalStyleKeys) {
    if (key in element) {
      style[key] = element[key];
    }
  }
  return style;
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
