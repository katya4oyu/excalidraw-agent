import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import type { AppDatabase } from "./db";
import type { AgentSupervisor } from "./agent";
import type { CollabDocumentName } from "@excalidraw-agent/shared";

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

    async onChange({ documentName }) {
      agents.markFromDocumentName(documentName, "verified");
    },
  });
};
