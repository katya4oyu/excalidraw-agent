import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import {
  type AgentRunRequest,
  type AgentRunQueueRequest,
  fileIdFromDocumentName,
  getAgentInstructionPrompt,
  getNoteEmbedMetadata,
  getNoteText,
  normalizeExcalidrawElementPositions,
  type CollabDocumentName,
  type FileId,
} from "@excalidraw-agent/shared";

interface CollabDatabase {
  loadDocument(documentName: CollabDocumentName): Uint8Array | null;
  storeDocument(documentName: CollabDocumentName, state: Uint8Array): void;
}

interface CollabAgentSupervisor extends AgentInstructionStarter {
  ensureWorker(fileId: FileId): unknown;
  markFromDocumentName(documentName: string, status: "verified"): void;
  scheduleIdleWorkerStop(fileId: FileId): void;
  cancelIdleWorkerStop(fileId: FileId): void;
}

export const createCollabServer = (db: CollabDatabase, agents: CollabAgentSupervisor): Hocuspocus => {
  const connectionCounts = new Map<FileId, number>();

  return new Hocuspocus({
    name: "excalidraw-agent-collab",
    debounce: 500,
    maxDebounce: 2_000,

    async connected({ documentName, requestParameters }) {
      const fileId = fileIdFromDocumentName(documentName);
      if (!fileId || isWorkerConnection(requestParameters)) {
        return;
      }

      connectionCounts.set(fileId, (connectionCounts.get(fileId) ?? 0) + 1);
      agents.cancelIdleWorkerStop(fileId);
      agents.ensureWorker(fileId);
    },

    async onDisconnect({ documentName, requestParameters }) {
      const fileId = fileIdFromDocumentName(documentName);
      if (!fileId || isWorkerConnection(requestParameters)) {
        return;
      }

      const nextCount = Math.max((connectionCounts.get(fileId) ?? 1) - 1, 0);
      if (nextCount > 0) {
        connectionCounts.set(fileId, nextCount);
        return;
      }

      connectionCounts.delete(fileId);
      agents.scheduleIdleWorkerStop(fileId);
    },

    async onLoadDocument({ documentName }) {
      const persisted = db.loadDocument(documentName as CollabDocumentName);
      const ydoc = new Y.Doc();

      if (persisted) {
        Y.applyUpdate(ydoc, persisted);
      }
      normalizeExcalidrawElementPositions(ydoc);

      const fileId = fileIdFromDocumentName(documentName);
      if (fileId) {
        startAgentFromInstructionRequests(ydoc, fileId, agents);
      }

      return ydoc;
    },

    async onStoreDocument({ documentName, document }) {
      const state = Y.encodeStateAsUpdate(document);
      db.storeDocument(documentName as CollabDocumentName, state);
    },

    async onChange({ documentName, document }) {
      const fileId = fileIdFromDocumentName(documentName);
      if (fileId) {
        startAgentFromInstructionRequests(document, fileId, agents);
      }

      if (!fileId || !agents.isRunActive(fileId)) {
        agents.markFromDocumentName(documentName, "verified");
      }
    },
  });
};

interface AgentInstructionStarter {
  enqueueRun(fileId: FileId, request: AgentRunQueueRequest): boolean;
  ensureWorker(fileId: FileId): unknown;
  isRunActive(fileId: FileId): boolean;
}

export const startAgentFromInstructionRequests = (
  document: Y.Doc,
  fileId: FileId,
  agents: AgentInstructionStarter,
): void => {
  agents.ensureWorker(fileId);

  if (agents.isRunActive(fileId)) {
    return;
  }

  const runRequests = document.getMap<Record<string, unknown>>("agentRunRequests");
  const legacyRequests = document.getMap<Record<string, unknown>>("agentInstructionRequests");
  const agentRuns = document.getMap<Record<string, unknown>>("agentRuns");
  const notes = document.getMap<Record<string, unknown>>("notes");
  const legacyInstructionNotes = document.getMap<Record<string, unknown>>("agentInstructionNotes");
  const elementsById = new Map<string, unknown>();
  for (const item of document.getArray<Y.Map<unknown>>("elements").toArray()) {
    const element = item.get("el");
    if (isRecord(element) && typeof element.id === "string") {
      elementsById.set(element.id, element);
    }
  }

  const candidates = [
    ...Array.from(runRequests.entries()).map(([requestId, request]) => ({
      requestId,
      request,
      store: runRequests,
    })),
    ...Array.from(legacyRequests.entries()).map(([requestId, request]) => ({
      requestId,
      request: normalizeLegacyRequest(fileId, request),
      store: legacyRequests,
    })),
  ];

  for (const { requestId, request, store } of candidates) {
    if (!isQueuedAgentRunRequest(request)) {
      continue;
    }

    const instructionRequest = request.source === "instruction-note" ? request as QueuedInstructionRequest : null;
    if (instructionRequest) {
      const currentPrompt = getCurrentInstructionPrompt(instructionRequest, {
        elementsById,
        legacyInstructionNotes,
        notes,
      });
      if (currentPrompt !== request.prompt) {
        store.set(requestId, {
          ...request,
          status: "stale",
          updatedAt: Date.now(),
        });
        continue;
      }
    }

    const now = Date.now();
    const runId = `agent-run-${randomUUID()}`;
    const queued = agents.enqueueRun(fileId, {
      fileId,
      prompt: request.prompt,
      requestId,
      runId,
    });
    if (!queued) {
      return;
    }

    document.transact(() => {
      const runningRequest = {
        ...request,
        status: "running",
        runId,
        updatedAt: now,
      };
      runRequests.set(requestId, runningRequest);
      if (store !== runRequests) {
        store.set(requestId, runningRequest);
      }
      agentRuns.set(runId, {
        status: "running",
        source: request.source,
        prompt: request.prompt,
        ...(instructionRequest?.elementId ? { instructionElementIds: [instructionRequest.elementId] } : {}),
        ...(instructionRequest?.noteId ? { sourceNoteId: instructionRequest.noteId } : {}),
        ...(instructionRequest?.sourceNoteId ? { sourceNoteId: instructionRequest.sourceNoteId } : {}),
        createdAt: now,
        updatedAt: now,
      });
    });
    return;
  }
};

const getCurrentInstructionPrompt = (
  request: QueuedInstructionRequest,
  stores: {
    elementsById: Map<string, unknown>;
    legacyInstructionNotes: Y.Map<Record<string, unknown>>;
    notes: Y.Map<Record<string, unknown>>;
  },
): string | null => {
  const noteId = request.sourceNoteId ?? request.noteId;
  if (noteId) {
    return (
      getNoteText(stores.notes.get(noteId) ?? stores.legacyInstructionNotes.get(noteId)) ??
      getNoteEmbedMetadata(stores.elementsById.get(noteId))?.text?.trim() ??
      null
    );
  }

  if (request.elementId) {
    return getAgentInstructionPrompt(stores.elementsById.get(request.elementId));
  }

  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isWorkerConnection = (requestParameters: URLSearchParams): boolean => {
  return requestParameters.get("source") === "worker";
};

type QueuedInstructionRequest = AgentRunRequest & {
  createdAt: number;
  elementId?: string;
  noteId?: string;
  sourceNoteId?: string;
  prompt: string;
  source: "instruction-note";
  status: "queued";
};

type QueuedAgentRequest = (AgentRunRequest | QueuedInstructionRequest) & { status: "queued" };

const isQueuedAgentRunRequest = (value: unknown): value is QueuedAgentRequest => {
  if (!isRecord(value) || value.status !== "queued" || typeof value.prompt !== "string" || !value.prompt.trim()) {
    return false;
  }

  if (
    value.source === "api" ||
    value.source === "manual" ||
    value.source === "auto-idle"
  ) {
    return typeof value.createdAt === "number" && typeof value.fileId === "string";
  }

  return (
    value.source === "instruction-note" &&
    (
      typeof value.elementId === "string" ||
      typeof value.noteId === "string" ||
      typeof value.sourceNoteId === "string"
    ) &&
    typeof value.createdAt === "number"
  );
};

const normalizeLegacyRequest = (fileId: FileId, value: unknown): unknown => {
  if (!isRecord(value) || value.status !== "queued" || typeof value.prompt !== "string") {
    return value;
  }

  const now = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  if (value.schemaVersion === 1 && typeof value.fileId === "string") {
    return value;
  }

  if (value.source === "api") {
    return {
      schemaVersion: 1,
      status: "queued",
      source: "api",
      prompt: value.prompt,
      fileId,
      trigger: { type: "api" },
      createdAt: now,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    } satisfies AgentRunRequest;
  }

  if (value.source === "instruction-note") {
    return {
      schemaVersion: 1,
      status: "queued",
      source: "instruction-note",
      prompt: value.prompt,
      fileId,
      trigger: { type: "instruction-note" },
      ...(typeof value.elementId === "string" ? { elementId: value.elementId } : {}),
      ...(typeof value.noteId === "string" ? { noteId: value.noteId } : {}),
      ...(typeof value.sourceNoteId === "string" ? { sourceNoteId: value.sourceNoteId } : {}),
      createdAt: now,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    } satisfies AgentRunRequest & {
      elementId?: string;
      noteId?: string;
      sourceNoteId?: string;
    };
  }

  return value;
};
