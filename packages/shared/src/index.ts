import * as Y from "yjs";

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
}

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
  pos = `${Date.now()}:${crypto.randomUUID()}`,
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
  ydoc.getArray<Y.Map<unknown>>("elements").push([createExcalidrawYMap(element)]);
};

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
