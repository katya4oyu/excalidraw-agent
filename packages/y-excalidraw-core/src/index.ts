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
export type AgentProposalStatus = "proposed" | "approved" | "rejected" | "stale" | "conflicted";
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
  baseRevision?: string;
  baseElementSnapshot?: AgentProposalBaseElementSnapshot;
  originalStyle?: Record<string, unknown>;
  createdAt: number;
}

export interface AgentProposalBaseElementSnapshot {
  id: string;
  version?: number;
  versionNonce?: number;
  updated?: number;
  isDeleted?: boolean;
  snapshot?: Record<string, unknown>;
}

export interface AgentGhostElementOptions {
  runId: string;
  proposalId?: string;
  operation: AgentGhostOperation;
  targetElementId?: string;
  finalElementId?: string;
  baseRevision?: string;
  baseElementSnapshot?: AgentProposalBaseElementSnapshot;
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
  baseRevision,
  baseElementSnapshot,
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
    baseRevision,
    baseElementSnapshot,
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
    ...(typeof metadata.baseRevision === "string" ? { baseRevision: metadata.baseRevision } : {}),
    ...(isAgentProposalBaseElementSnapshot(metadata.baseElementSnapshot)
      ? { baseElementSnapshot: metadata.baseElementSnapshot }
      : {}),
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

  const proposedGhosts = getProposalGhosts(stores.elements, proposalId);
  if (proposedGhosts.length === 0) {
    return false;
  }

  if (proposedGhosts.some(({ metadata }) => metadata.operation !== "add")) {
    markProposalConflict(stores, proposal, proposalId, now, "unsupported_operation");
    return false;
  }

  if (proposedGhosts.some(({ metadata }) => isBaseElementSnapshotStale(stores.elements, metadata))) {
    markProposalStale(stores, proposal, proposalId, now);
    return false;
  }

  if (proposedGhosts.some(({ metadata }) =>
    typeof metadata.finalElementId === "string" &&
    hasLiveElementWithId(stores.elements, metadata.finalElementId),
  )) {
    markProposalConflict(stores, proposal, proposalId, now, "final_element_id_exists");
    return false;
  }

  let changed = false;
  stores.elements.doc?.transact(() => {
    for (const { item, element, metadata } of proposedGhosts) {
      item.set("el", materializeAgentGhostElement(element, metadata, now));
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
    for (const { item, element } of getProposalGhosts(stores.elements, proposalId)) {
      item.set("el", markElementDeleted(element, now));
      changed = true;
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
    changed = true;
  });

  return changed;
};

const markProposalConflict = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
  proposal: Record<string, unknown>,
  proposalId: string,
  now: number,
  conflictReason: string,
): void => {
  stores.elements.doc?.transact(() => {
    stores.agentProposals?.set(proposalId, {
      ...proposal,
      status: "conflicted",
      conflictReason,
      updatedAt: now,
    });
    const runId = typeof proposal.runId === "string" ? proposal.runId : proposalId;
    const run = stores.agentRuns?.get(runId);
    stores.agentRuns?.set(runId, {
      ...(isRecord(run) ? run : {}),
      status: "conflicted",
      conflictReason,
      updatedAt: now,
    });
  });
};

const markProposalStale = (
  stores: Pick<ExcalidrawYStores, "elements" | "agentRuns" | "agentProposals">,
  proposal: Record<string, unknown>,
  proposalId: string,
  now: number,
): void => {
  stores.elements.doc?.transact(() => {
    stores.agentProposals?.set(proposalId, {
      ...proposal,
      status: "stale",
      staleAt: now,
      updatedAt: now,
    });
    const runId = typeof proposal.runId === "string" ? proposal.runId : proposalId;
    const run = stores.agentRuns?.get(runId);
    stores.agentRuns?.set(runId, {
      ...(isRecord(run) ? run : {}),
      status: "conflicted",
      staleAt: now,
      updatedAt: now,
    });
  });
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

const markElementDeleted = (
  element: Record<string, unknown>,
  now: number,
): Record<string, unknown> => {
  return {
    ...element,
    isDeleted: true,
    updated: now,
    version: typeof element.version === "number" ? element.version + 1 : 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
  };
};

const getProposalGhosts = (
  elements: Y.Array<Y.Map<unknown>>,
  proposalId: string,
): { item: Y.Map<unknown>; element: Record<string, unknown>; metadata: ExcalidrawAgentGhostElementMetadata }[] => {
  return elements.toArray().flatMap((item) => {
    const element = item.get("el");
    const metadata = getAgentGhostMetadata(element);
    if (!metadata || metadata.proposalId !== proposalId || !isRecord(element)) {
      return [];
    }
    return [{ item, element, metadata }];
  });
};

const hasLiveElementWithId = (
  elements: Y.Array<Y.Map<unknown>>,
  elementId: string,
): boolean => {
  return elements.toArray().some((item) => {
    const element = item.get("el");
    return isRecord(element) && element.id === elementId && element.isDeleted !== true;
  });
};

const isBaseElementSnapshotStale = (
  elements: Y.Array<Y.Map<unknown>>,
  metadata: ExcalidrawAgentGhostElementMetadata,
): boolean => {
  const snapshot = metadata.baseElementSnapshot;
  if (!snapshot) {
    return false;
  }

  const current = findLiveElementById(elements, snapshot.id);
  if (!current) {
    return snapshot.isDeleted !== true;
  }

  return (
    (typeof snapshot.version === "number" && current.version !== snapshot.version) ||
    (typeof snapshot.versionNonce === "number" && current.versionNonce !== snapshot.versionNonce) ||
    (typeof snapshot.updated === "number" && current.updated !== snapshot.updated) ||
    (typeof snapshot.isDeleted === "boolean" && current.isDeleted !== snapshot.isDeleted)
  );
};

const findLiveElementById = (
  elements: Y.Array<Y.Map<unknown>>,
  elementId: string,
): Record<string, unknown> | null => {
  for (const item of elements.toArray()) {
    const element = item.get("el");
    if (isRecord(element) && element.id === elementId && element.isDeleted !== true) {
      return element;
    }
  }
  return null;
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

const isAgentProposalBaseElementSnapshot = (value: unknown): value is AgentProposalBaseElementSnapshot => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return false;
  }

  return (
    (value.version === undefined || typeof value.version === "number") &&
    (value.versionNonce === undefined || typeof value.versionNonce === "number") &&
    (value.updated === undefined || typeof value.updated === "number") &&
    (value.isDeleted === undefined || typeof value.isDeleted === "boolean") &&
    (value.snapshot === undefined || isRecord(value.snapshot))
  );
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
  return (
    value === "proposed" ||
    value === "approved" ||
    value === "rejected" ||
    value === "stale" ||
    value === "conflicted"
  );
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
