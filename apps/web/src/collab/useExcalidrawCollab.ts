import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  createAgentInstructionNoteElements,
  insertExcalidrawElements,
  toDocumentName,
} from "@excalidraw-agent/shared";
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
  const ydocRef = useRef<Y.Doc | null>(null);
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
    ydocRef.current = ydoc;
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
      ydocRef.current = null;
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

  const addAgentInstruction = useCallback(() => {
    if (!api || !ydocRef.current) {
      return;
    }

    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const elementWidth = 420;
    const elementHeight = 120;
    const viewportLeft = -appState.scrollX;
    const viewportTop = -appState.scrollY;
    const viewportWidth = appState.width / zoom;
    const viewportHeight = appState.height / zoom;
    const x = clamp(
      viewportLeft + viewportWidth / 2 + 40,
      viewportLeft + 24,
      viewportLeft + viewportWidth - elementWidth - 24,
    );
    const y = clamp(
      viewportTop + viewportHeight / 2 - elementHeight / 2,
      viewportTop + 24,
      viewportTop + viewportHeight - elementHeight - 96,
    );

    insertExcalidrawElements(
      ydocRef.current,
      createAgentInstructionNoteElements({
        x,
        y,
        text: "Agentへの置き手紙を書いてください",
      }),
    );
  }, [api]);

  return {
    addAgentInstruction,
    api,
    agentFooterState,
    binding,
    setApi,
    status,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
