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
        startAgentFromInstructionNotes(document, fileId, agents);
      }

      if (!fileId || !agents.isRunning(fileId)) {
        agents.markFromDocumentName(documentName, "verified");
      }
    },
  });
};

const startAgentFromInstructionNotes = (
  document: Y.Doc,
  fileId: FileId,
  agents: AgentSupervisor,
): void => {
  if (agents.isRunning(fileId)) {
    return;
  }

  const elements = document.getArray<Y.Map<unknown>>("elements").toArray();
  const requests = document.getMap<Record<string, unknown>>("agentInstructionRequests");
  const agentRuns = document.getMap<Record<string, unknown>>("agentRuns");

  for (const item of elements) {
    const element = item.get("el");
    const prompt = getAgentInstructionPrompt(element);
    if (!prompt || !isRecord(element) || typeof element.id !== "string") {
      continue;
    }

    const existing = requests.get(element.id);
    if (isRecord(existing) && existing.prompt === prompt) {
      continue;
    }

    const started = agents.start(fileId, { prompt });
    if (!started) {
      return;
    }

    const now = Date.now();
    const runId = `agent-run-${randomUUID()}`;
    document.transact(() => {
      requests.set(element.id as string, {
        status: "running",
        source: "instruction-note",
        prompt,
        runId,
        elementId: element.id,
        createdAt: now,
        updatedAt: now,
      });
      agentRuns.set(runId, {
        status: "running",
        source: "instruction-note",
        prompt,
        instructionElementIds: [element.id],
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
