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

export interface AgentWorkerOptions {
  fileId: FileId;
  serverUrl: string;
  workspaceRoot: string;
  workspaceTemplate: string;
  prompt?: string;
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
