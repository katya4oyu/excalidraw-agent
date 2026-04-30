import { useEffect, useMemo, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { toDocumentName } from "@excalidraw-agent/shared";
import {
  createAgentFooterStateObserver,
  ExcalidrawBinding,
  type AgentFooterState,
} from "@excalidraw-agent/y-excalidraw-browser";
import * as Y from "yjs";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

interface UseExcalidrawCollabOptions {
  fileId: string;
  excalidrawElement: HTMLElement | null;
}

export function useExcalidrawCollab({ fileId, excalidrawElement }: UseExcalidrawCollabOptions) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState("connecting");
  const [binding, setBinding] = useState<ExcalidrawBinding | null>(null);
  const [agentFooterState, setAgentFooterState] = useState<AgentFooterState>({
    runStatus: "idle",
    activeRunCount: 0,
    proposedCount: 0,
    ghostElementCount: 0,
  });

  const collabUrl = useMemo(() => {
    if (import.meta.env.VITE_COLLAB_URL) {
      return import.meta.env.VITE_COLLAB_URL;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/collab`;
  }, []);

  useEffect(() => {
    if (!api || !excalidrawElement) {
      return;
    }

    const provider = new HocuspocusProvider({
      url: collabUrl,
      name: toDocumentName(fileId),
    });

    const awareness = provider.awareness;
    if (!awareness) {
      setStatus("disconnected");
      provider.destroy();
      return;
    }

    awareness.setLocalStateField("user", {
      name: "Human",
      color: "#246b5b",
      role: "human",
    });

    const ydoc = provider.document;
    const yElements = ydoc.getArray<Y.Map<any>>("elements");
    const yAssets = ydoc.getMap("assets");
    const yAgentRuns = ydoc.getMap("agentRuns");
    const yAgentProposals = ydoc.getMap("agentProposals");
    const localOrigin = {};
    const undoManagerOptions = excalidrawElement.querySelector(".undo-redo-buttons")
      ? {
          excalidrawDom: excalidrawElement,
          undoManager: new Y.UndoManager(yElements, {
            trackedOrigins: new Set([localOrigin]),
          }),
        }
      : undefined;

    const nextBinding = new ExcalidrawBinding(
      yElements,
      yAssets,
      api,
      awareness,
      undoManagerOptions,
    );

    const handleStatus = ({ status: nextStatus }: { status: string }) => {
      setStatus(nextStatus);
    };

    provider.on("status", handleStatus);
    const handleSynced = () => {
      const importedAppState = ydoc.getMap("appState").toJSON();
      if (Object.keys(importedAppState).length > 0) {
        api.updateScene({ appState: importedAppState as any });
      }
      setStatus("synced");
    };
    provider.on("synced", handleSynced);

    setBinding(nextBinding);
    const destroyAgentFooterStateObserver = createAgentFooterStateObserver(
      {
        elements: yElements,
        agentRuns: yAgentRuns,
        agentProposals: yAgentProposals,
      },
      setAgentFooterState,
    );

    return () => {
      setBinding(null);
      setAgentFooterState({
        runStatus: "idle",
        activeRunCount: 0,
        proposedCount: 0,
        ghostElementCount: 0,
      });
      destroyAgentFooterStateObserver();
      provider.off("status", handleStatus);
      provider.off("synced", handleSynced);
      nextBinding.destroy();
      provider.destroy();
    };
  }, [api, collabUrl, excalidrawElement, fileId]);

  return {
    api,
    agentFooterState,
    binding,
    setApi,
    status,
  };
}
