import * as Y from "yjs";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export type FileId = string;
export type CollabDocumentName = `file:${FileId}`;

export interface FileMetadata {
  id: FileId;
  documentName: CollabDocumentName;
  createdAt: string;
  updatedAt: string;
  agentStatus: AgentStatus;
}

export type AgentStatus = "idle" | "starting" | "running" | "verified" | "failed";

export interface CreateFileResponse {
  id: FileId;
}

export interface ImportFileRequest {
  fileId?: FileId;
  document: ExcalidrawDocumentData;
}

export interface ImportFileResponse {
  id: FileId;
  documentName: CollabDocumentName;
  created: boolean;
  imported: boolean;
}

export interface AgentWorkerOptions {
  fileId: FileId;
  serverUrl: string;
  workspaceRoot: string;
  workspaceTemplate: string;
  prompt?: string;
  daemon?: boolean;
}

export interface AgentRunQueueRequest {
  fileId: FileId;
  requestId: string;
  runId: string;
  prompt: string;
}

export type AgentRunRequestStatus =
  | "queued"
  | "running"
  | "proposed"
  | "applied"
  | "rejected"
  | "stale"
  | "failed";

export type AgentRunRequestSource = "manual" | "auto-idle" | "instruction-note" | "api";

export interface AgentRunRequest {
  schemaVersion: 1;
  status: AgentRunRequestStatus;
  source: AgentRunRequestSource;
  prompt: string;
  fileId: FileId;
  runId?: string;
  trigger: {
    type: "button" | "idle-after-edit" | "instruction-note" | "api";
    idleMs?: number;
    changedElementIds?: string[];
  };
  baseRevision?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSettings {
  schemaVersion: 1;
  autoModeEnabled: boolean;
  autoIdleMs: number;
  updatedAt: number;
}

export interface ElementVersionSnapshot {
  id: string;
  version?: number;
  versionNonce?: number;
  updated?: number;
  isDeleted?: boolean;
  index?: string;
}

export interface BaseRevisionSnapshot {
  schemaVersion: 1;
  hash: string;
  elements: ElementVersionSnapshot[];
}

export type DerivedPatchOperation =
  | {
      type: "add";
      element: Record<string, unknown>;
    }
  | {
      type: "unsupported";
      reason: "update" | "delete" | "move";
      elementId: string;
    };

export interface DerivedPatch {
  schemaVersion: 1;
  baseRevision: string;
  operations: DerivedPatchOperation[];
  unsupportedCount: number;
  createdAt: number;
}

export type AgentWorkerRunFinishedStatus = "proposed" | "conflicted" | "failed";

export type AgentWorkerRequestMessage =
  | { type: "runQueued"; fileId: FileId; request: AgentRunQueueRequest }
  | { type: "shutdown"; reason?: string };

export type AgentWorkerResponseMessage =
  | { type: "ready"; fileId: FileId }
  | { type: "runStarted"; fileId: FileId; runId: string }
  | { type: "runFinished"; fileId: FileId; runId: string; status: AgentWorkerRunFinishedStatus }
  | { type: "workerFailed"; fileId: FileId; error: string; runId?: string };

export interface ExcalidrawAgentMetadata {
  schemaVersion: 1;
  fileId: FileId;
  documentName: CollabDocumentName;
  serverBaseUrl?: string;
  sidecarFile?: string;
  updatedAt: string;
}

export interface ExcalidrawDocumentData {
  type?: string;
  version?: number;
  source?: string;
  elements?: readonly Record<string, unknown>[] | null;
  appState?: Record<string, unknown> | null;
  files?: Record<string, unknown>;
  excalidrawAgent?: ExcalidrawAgentMetadata | null;
}

export interface ExcalidrawYElement {
  el: Record<string, unknown>;
  pos: string;
}

export interface AgentInstructionElementOptions {
  x: number;
  y: number;
  text: string;
  width?: number;
  height?: number;
}

export interface NoteEmbedOptions {
  fileId: FileId;
  link: string;
  noteId?: string;
  text?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface ExcalidrawAgentInstructionElementMetadata {
  schemaVersion: 1;
  kind: "instruction";
}

export interface ExcalidrawNoteEmbedMetadata {
  schemaVersion: 1;
  kind: "note-embed";
  fileId: FileId;
  noteId: string;
  text?: string;
}

export type NoteStatus =
  | "idle"
  | "queued"
  | "running"
  | "proposed"
  | "conflicted"
  | "failed";

export interface NoteRecord {
  schemaVersion: 1;
  fileId: FileId;
  noteId: string;
  text: string;
  status: NoteStatus;
  requestId?: string;
  runId?: string;
  createdAt: number;
  updatedAt: number;
}

export type NoteToParentMessage =
  | { type: "excalidraw-agent:noteReady"; fileId: FileId; noteId: string }
  | { type: "excalidraw-agent:noteTextChanged"; fileId: FileId; noteId: string; text: string }
  | { type: "excalidraw-agent:noteResizeRequested"; fileId: FileId; noteId: string; width: number; height: number };

export type ParentToNoteMessage = {
  type: "excalidraw-agent:noteState";
  fileId: FileId;
  note: NoteRecord;
};

export const agentInstructionPlaceholderText = "Agentへの置き手紙を書いてください";

export const excalidrawAgentInstructionElementMetadata = {
  schemaVersion: 1,
  kind: "instruction",
} as const satisfies ExcalidrawAgentInstructionElementMetadata;

export const toDocumentName = (fileId: FileId): CollabDocumentName => {
  if (!fileId.trim()) {
    throw new Error("fileId is required");
  }

  return `file:${fileId}`;
};

export const fileIdFromDocumentName = (name: string): FileId | null => {
  return name.startsWith("file:") ? name.slice("file:".length) : null;
};

export const createFileId = (): FileId => {
  return crypto.randomUUID();
};

export const createExcalidrawAgentMetadata = (
  fileId: FileId,
  options: {
    serverBaseUrl?: string;
    sidecarFile?: string;
    updatedAt?: string;
  } = {},
): ExcalidrawAgentMetadata => {
  return {
    schemaVersion: 1,
    fileId,
    documentName: toDocumentName(fileId),
    serverBaseUrl: options.serverBaseUrl,
    sidecarFile: options.sidecarFile,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
};

export const getExcalidrawAgentMetadata = (
  data: unknown,
): ExcalidrawAgentMetadata | null => {
  if (!isRecord(data)) {
    return null;
  }

  const candidate = isRecord(data.excalidrawAgent) ? data.excalidrawAgent : data;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.fileId !== "string" ||
    !candidate.fileId.trim() ||
    typeof candidate.documentName !== "string" ||
    candidate.documentName !== toDocumentName(candidate.fileId) ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    fileId: candidate.fileId,
    documentName: candidate.documentName as CollabDocumentName,
    serverBaseUrl: typeof candidate.serverBaseUrl === "string" ? candidate.serverBaseUrl : undefined,
    sidecarFile: typeof candidate.sidecarFile === "string" ? candidate.sidecarFile : undefined,
    updatedAt: candidate.updatedAt,
  };
};

export const withExcalidrawAgentMetadata = <T extends Record<string, unknown>>(
  document: T,
  metadata: ExcalidrawAgentMetadata,
): T & { excalidrawAgent: ExcalidrawAgentMetadata } => {
  return {
    ...document,
    excalidrawAgent: metadata,
  };
};

export const createExcalidrawYMap = (
  element: Record<string, unknown>,
  pos = getElementOrderKey(element) ?? generateKeyBetween(null, null),
): Y.Map<unknown> => {
  const item = new Y.Map<unknown>();
  item.set("el", element);
  item.set("pos", pos);
  return item;
};

export const insertExcalidrawElement = (
  ydoc: Y.Doc,
  element: Record<string, unknown>,
): void => {
  const elements = ydoc.getArray<Y.Map<unknown>>("elements");
  const pos = getElementOrderKey(element) ?? generateKeyBetween(getLastElementOrderKey(elements), null);
  elements.push([createExcalidrawYMap(element, pos)]);
};

export const insertExcalidrawElements = (
  ydoc: Y.Doc,
  elements: readonly Record<string, unknown>[],
): void => {
  const yElements = ydoc.getArray<Y.Map<unknown>>("elements");
  const positions = generateNKeysBetween(getLastElementOrderKey(yElements), null, elements.length);
  yElements.push(elements.map((element, index) =>
    createExcalidrawYMap(element, getElementOrderKey(element) ?? positions[index]),
  ));
};

export const normalizeExcalidrawElementPositions = (ydoc: Y.Doc): boolean => {
  const elements = ydoc.getArray<Y.Map<unknown>>("elements");
  const items = elements.toArray();
  const seen = new Set<string>();
  const shouldNormalize = items.some((item) => {
    const pos = item.get("pos");
    if (!isValidElementOrderKey(pos) || seen.has(pos)) {
      return true;
    }
    seen.add(pos);
    return false;
  });

  if (!shouldNormalize) {
    return false;
  }

  const positions = generateNKeysBetween(null, null, items.length);
  items.forEach((item, index) => {
    item.set("pos", positions[index]);
  });
  return true;
};

export const createAgentInstructionElement = ({
  x,
  y,
  text,
}: AgentInstructionElementOptions): Record<string, unknown> => {
  const now = Date.now();

  return {
    id: `agent-instruction-${crypto.randomUUID()}`,
    type: "text",
    x,
    y,
    width: 420,
    height: 120,
    angle: 0,
    strokeColor: "#123c69",
    backgroundColor: "#e8f3ff",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
    customData: {
      excalidrawAgent: excalidrawAgentInstructionElementMetadata,
    },
  };
};

export const createAgentInstructionNoteElements = ({
  height = 120,
  x,
  y,
  text,
  width = 420,
}: AgentInstructionElementOptions): Record<string, unknown>[] => {
  const now = Date.now();
  const groupId = `agent-instruction-group-${crypto.randomUUID()}`;
  const noteId = `agent-instruction-note-${crypto.randomUUID()}`;
  const textId = `agent-instruction-${crypto.randomUUID()}`;

  return [
    {
      id: noteId,
      type: "rectangle",
      x,
      y,
      width,
      height,
      angle: 0,
      strokeColor: "#8a6d1d",
      backgroundColor: "#fff3bf",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [groupId],
      frameId: null,
      roundness: {
        type: 3,
      },
      seed: Math.floor(Math.random() * 1_000_000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 1_000_000),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      customData: {
        excalidrawAgent: excalidrawAgentInstructionElementMetadata,
      },
    },
    {
      id: textId,
      type: "text",
      x: x + 16,
      y: y + 16,
      width: Math.max(0, width - 32),
      height: Math.max(0, height - 32),
      angle: 0,
      strokeColor: "#4f3f16",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [groupId],
      frameId: null,
      roundness: null,
      seed: Math.floor(Math.random() * 1_000_000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 1_000_000),
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      text,
      originalText: text,
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      lineHeight: 1.25,
      customData: {
        excalidrawAgent: excalidrawAgentInstructionElementMetadata,
      },
    },
  ];
};

export const createNoteRecord = (
  fileId: FileId,
  noteId: string,
  now = Date.now(),
): NoteRecord => ({
  schemaVersion: 1,
  fileId,
  noteId,
  text: "",
  status: "idle",
  createdAt: now,
  updatedAt: now,
});

export const createNoteEmbedElement = ({
  fileId,
  height = 220,
  link,
  noteId = `note-${crypto.randomUUID()}`,
  text = "",
  width = 420,
  x,
  y,
}: NoteEmbedOptions): Record<string, unknown> => {
  const now = Date.now();

  return {
    id: noteId,
    type: "embeddable",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#d0d0d0",
    backgroundColor: "#ffffff",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: {
      type: 3,
    },
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link,
    locked: false,
    customData: {
      excalidrawAgent: {
        schemaVersion: 1,
        kind: "note-embed",
        fileId,
        noteId,
        text,
      } satisfies ExcalidrawNoteEmbedMetadata,
    },
  };
};

export const isAgentInstructionElement = (element: unknown): boolean => {
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
    metadata.kind === "instruction"
  );
};

export const getAgentInstructionPrompt = (element: unknown): string | null => {
  if (!isAgentInstructionElement(element) || !isRecord(element) || element.type !== "text") {
    return null;
  }

  const text = typeof element.text === "string" ? element.text.trim() : "";
  if (!text || text === agentInstructionPlaceholderText) {
    return null;
  }

  return text;
};

export const getNoteEmbedMetadata = (
  element: unknown,
): ExcalidrawNoteEmbedMetadata | null => {
  if (!isRecord(element)) {
    return null;
  }

  const customData = element.customData;
  if (!isRecord(customData)) {
    return null;
  }

  const metadata = customData.excalidrawAgent;
  if (
    !isRecord(metadata) ||
    metadata.schemaVersion !== 1 ||
    metadata.kind !== "note-embed" ||
    typeof metadata.fileId !== "string" ||
    typeof metadata.noteId !== "string"
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "note-embed",
    fileId: metadata.fileId,
    noteId: metadata.noteId,
    ...(typeof metadata.text === "string" ? { text: metadata.text } : {}),
  };
};

export const getNoteText = (note: unknown): string | null => {
  if (!isRecord(note) || note.schemaVersion !== 1 || typeof note.text !== "string") {
    return null;
  }

  const text = note.text.trim();
  return text ? text : null;
};

export const defaultAgentSettings = (now = Date.now()): AgentSettings => ({
  schemaVersion: 1,
  autoModeEnabled: false,
  autoIdleMs: 30_000,
  updatedAt: now,
});

export const createAgentRunRequest = (input: {
  fileId: FileId;
  prompt: string;
  source: AgentRunRequestSource;
  trigger: AgentRunRequest["trigger"];
  baseRevision?: string;
  now?: number;
}): AgentRunRequest => {
  const now = input.now ?? Date.now();

  return {
    schemaVersion: 1,
    status: "queued",
    source: input.source,
    prompt: input.prompt,
    fileId: input.fileId,
    trigger: input.trigger,
    ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
    createdAt: now,
    updatedAt: now,
  };
};

export const createAgentRunRequestFromInstruction = (input: {
  fileId: FileId;
  prompt: string;
  now?: number;
}): AgentRunRequest => {
  return createAgentRunRequest({
    fileId: input.fileId,
    prompt: input.prompt,
    source: "instruction-note",
    trigger: {
      type: "instruction-note",
    },
    now: input.now,
  });
};

export const createBaseRevisionSnapshot = (input: {
  elements: readonly Record<string, unknown>[];
  assets?: Record<string, unknown> | null;
  notes?: Record<string, unknown> | null;
}): BaseRevisionSnapshot => {
  const visibleElements = input.elements
    .filter((element) => element.isDeleted !== true && typeof element.id === "string")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const canonical = stableStringify({
    assets: normalizeStableRecord(input.assets),
    elements: visibleElements.map(normalizeSceneElementForRevision),
    notes: normalizeStableRecord(input.notes),
  });

  return {
    schemaVersion: 1,
    hash: `scene:${fnv1aHash(canonical)}`,
    elements: visibleElements.map(toElementVersionSnapshot),
  };
};

export const findElementSnapshot = (
  snapshot: BaseRevisionSnapshot,
  elementId: string,
): ElementVersionSnapshot | null => {
  return snapshot.elements.find((element) => element.id === elementId) ?? null;
};

export type AgentInstructionEmbedOptions = NoteEmbedOptions;
export type ExcalidrawAgentInstructionEmbedMetadata = ExcalidrawNoteEmbedMetadata;
export type AgentInstructionNoteStatus = NoteStatus;
export type AgentInstructionNoteRecord = NoteRecord;
export type StickyNoteToParentMessage = NoteToParentMessage;
export type ParentToStickyNoteMessage = ParentToNoteMessage;
export const createAgentInstructionNoteRecord = createNoteRecord;
export const createAgentInstructionNoteEmbedElement = createNoteEmbedElement;
export const getAgentInstructionEmbedMetadata = getNoteEmbedMetadata;
export const getAgentInstructionNotePrompt = getNoteText;

export const createAgentDemoElement = (
  fileId: FileId,
): Record<string, unknown> => {
  const now = Date.now();

  return {
    id: `agent-note-${fileId}`,
    type: "text",
    x: 120,
    y: 120,
    width: 420,
    height: 90,
    angle: 0,
    strokeColor: "#123c69",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text: "AI Agent joined this canvas.\nVerified changes will arrive through Yjs.",
    fontSize: 24,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    originalText: "AI Agent joined this canvas.\nVerified changes will arrive through Yjs.",
    lineHeight: 1.25,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeSceneElementForRevision = (element: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element).sort(([a], [b]) => a.localeCompare(b))) {
    if (
      key === "selected" ||
      key === "editing" ||
      key === "dragging" ||
      key === "customData" && isAgentTransientCustomData(value)
    ) {
      continue;
    }
    normalized[key] = normalizeStableValue(value);
  }
  return normalized;
};

const toElementVersionSnapshot = (element: Record<string, unknown>): ElementVersionSnapshot => ({
  id: String(element.id),
  ...(typeof element.version === "number" ? { version: element.version } : {}),
  ...(typeof element.versionNonce === "number" ? { versionNonce: element.versionNonce } : {}),
  ...(typeof element.updated === "number" ? { updated: element.updated } : {}),
  ...(typeof element.isDeleted === "boolean" ? { isDeleted: element.isDeleted } : {}),
  ...(typeof element.index === "string" ? { index: element.index } : {}),
});

const normalizeStableRecord = (value: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  return isRecord(value) ? normalizeStableValue(value) as Record<string, unknown> : {};
};

const normalizeStableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeStableValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    normalized[key] = normalizeStableValue(child);
  }
  return normalized;
};

const stableStringify = (value: unknown): string => {
  return JSON.stringify(normalizeStableValue(value));
};

const fnv1aHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const isAgentTransientCustomData = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  const metadata = value.excalidrawAgent;
  return isRecord(metadata) && metadata.kind === "proposal-ghost";
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
