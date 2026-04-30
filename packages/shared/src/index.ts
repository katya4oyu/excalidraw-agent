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

export interface AgentInstructionElementOptions {
  x: number;
  y: number;
  text: string;
  width?: number;
  height?: number;
}

export interface ExcalidrawAgentInstructionElementMetadata {
  schemaVersion: 1;
  kind: "instruction";
}

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

export const insertExcalidrawElements = (
  ydoc: Y.Doc,
  elements: readonly Record<string, unknown>[],
): void => {
  const now = Date.now();
  ydoc
    .getArray<Y.Map<unknown>>("elements")
    .push(elements.map((element, index) => createExcalidrawYMap(element, `${now + index}:${crypto.randomUUID()}`)));
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
