import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./db";
import type { AgentSupervisor } from "./agent";
import {
  fileIdFromDocumentName,
  getAgentInstructionPrompt,
  type CollabDocumentName,
  type FileId,
} from "@excalidraw-agent/shared";

export const createCollabServer = (db: AppDatabase, agents: AgentSupervisor): Hocuspocus => {
  return new Hocuspocus({
    name: "excalidraw-agent-collab",
    debounce: 500,
    maxDebounce: 2_000,

    async onLoadDocument({ documentName }) {
      const persisted = db.loadDocument(documentName as CollabDocumentName);
      const ydoc = new Y.Doc();

      if (persisted) {
        Y.applyUpdate(ydoc, persisted);
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

      if (!fileId || !agents.isRunning(fileId)) {
        agents.markFromDocumentName(documentName, "verified");
      }
    },
  });
};

interface AgentInstructionStarter {
  isRunning(fileId: FileId): boolean;
  start(fileId: FileId, options: { prompt?: string }): boolean;
}

export const startAgentFromInstructionRequests = (
  document: Y.Doc,
  fileId: FileId,
  agents: AgentInstructionStarter,
): void => {
  if (agents.isRunning(fileId)) {
    return;
  }

  const requests = document.getMap<Record<string, unknown>>("agentInstructionRequests");
  const agentRuns = document.getMap<Record<string, unknown>>("agentRuns");
  const elementsById = new Map<string, unknown>();
  for (const item of document.getArray<Y.Map<unknown>>("elements").toArray()) {
    const element = item.get("el");
    if (isRecord(element) && typeof element.id === "string") {
      elementsById.set(element.id, element);
    }
  }

  for (const [requestId, request] of requests.entries()) {
    if (!isQueuedInstructionRequest(request)) {
      continue;
    }

    const element = elementsById.get(request.elementId);
    const currentPrompt = getAgentInstructionPrompt(element);
    if (currentPrompt !== request.prompt) {
      requests.set(requestId, {
        ...request,
        status: "stale",
        updatedAt: Date.now(),
      });
      continue;
    }

    const started = agents.start(fileId, { prompt: request.prompt });
    if (!started) {
      return;
    }

    const now = Date.now();
    const runId = `agent-run-${randomUUID()}`;
    document.transact(() => {
      requests.set(requestId, {
        status: "running",
        source: "instruction-note",
        prompt: request.prompt,
        runId,
        elementId: request.elementId,
        createdAt: request.createdAt,
        updatedAt: now,
      });
      agentRuns.set(runId, {
        status: "running",
        source: "instruction-note",
        prompt: request.prompt,
        instructionElementIds: [request.elementId],
        createdAt: now,
        updatedAt: now,
      });
    });
    return;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isQueuedInstructionRequest = (value: unknown): value is {
  createdAt: number;
  elementId: string;
  prompt: string;
  source: "instruction-note";
  status: "queued";
} => {
  return (
    isRecord(value) &&
    value.status === "queued" &&
    value.source === "instruction-note" &&
    typeof value.prompt === "string" &&
    value.prompt.trim().length > 0 &&
    typeof value.elementId === "string" &&
    typeof value.createdAt === "number"
  );
};
