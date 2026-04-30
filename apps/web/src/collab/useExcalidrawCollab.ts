import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  agentInstructionPlaceholderText,
  createAgentInstructionNoteElements,
  getAgentInstructionPrompt,
  insertExcalidrawElements,
  toDocumentName,
} from "@excalidraw-agent/shared";
import {
  createAgentFooterStateObserver,
  ExcalidrawBinding,
  type AgentFooterState,
} from "@excalidraw-agent/y-excalidraw-browser";
import * as Y from "yjs";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  PointerDownState,
} from "@excalidraw/excalidraw/types";

interface UseExcalidrawCollabOptions {
  fileId: string;
  excalidrawElement: HTMLElement | null;
}

export function useExcalidrawCollab({ fileId, excalidrawElement }: UseExcalidrawCollabOptions) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState("connecting");
  const [binding, setBinding] = useState<ExcalidrawBinding | null>(null);
  const [isAgentInstructionMode, setIsAgentInstructionMode] = useState(false);
  const ydocRef = useRef<Y.Doc | null>(null);
  const requestedInstructionPromptsRef = useRef(new Map<string, string>());
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
      requestedInstructionPromptsRef.current.clear();
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

  useEffect(() => {
    if (!api) {
      return;
    }

    if (isAgentInstructionMode) {
      api.setCursor("crosshair");
      return () => {
        api.resetCursor();
      };
    }

    api.resetCursor();
  }, [api, isAgentInstructionMode]);

  const insertAgentInstructionAt = useCallback((x: number, y: number) => {
    if (!ydocRef.current) {
      return;
    }

    insertExcalidrawElements(
      ydocRef.current,
      createAgentInstructionNoteElements({
        x,
        y,
        text: agentInstructionPlaceholderText,
      }),
    );
  }, []);

  const insertAgentInstructionBox = useCallback((input: {
    height?: number;
    width?: number;
    x: number;
    y: number;
  }) => {
    if (!ydocRef.current) {
      return;
    }

    insertExcalidrawElements(
      ydocRef.current,
      createAgentInstructionNoteElements({
        ...input,
        text: agentInstructionPlaceholderText,
      }),
    );
  }, []);

  const addAgentInstruction = useCallback(() => {
    if (!api) {
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

    insertAgentInstructionAt(x, y);
  }, [api, insertAgentInstructionAt]);

  const toggleAgentInstructionMode = useCallback(() => {
    setIsAgentInstructionMode((current) => !current);
  }, []);

  const onChange = useCallback((elements: readonly Record<string, unknown>[], appState: AppState) => {
    if (isEditingText(appState) || !ydocRef.current) {
      return;
    }

    const requests = ydocRef.current.getMap<Record<string, unknown>>("agentInstructionRequests");
    for (const element of elements) {
      const prompt = getAgentInstructionPrompt(element);
      const elementId = getElementId(element);
      if (!prompt || !elementId) {
        continue;
      }

      const lastPrompt = requestedInstructionPromptsRef.current.get(elementId);
      const existing = requests.get(elementId);
      if (lastPrompt === prompt || (isRecord(existing) && existing.prompt === prompt)) {
        requestedInstructionPromptsRef.current.set(elementId, prompt);
        continue;
      }

      const now = Date.now();
      requests.set(elementId, {
        status: "queued",
        source: "instruction-note",
        prompt,
        elementId,
        createdAt: now,
        updatedAt: now,
      });
      requestedInstructionPromptsRef.current.set(elementId, prompt);
    }
  }, []);

  const onPointerUp = useCallback((
    _activeTool: AppState["activeTool"],
    pointerDownState: PointerDownState,
  ) => {
    if (!isAgentInstructionMode) {
      return;
    }

    const deltaX = pointerDownState.lastCoords.x - pointerDownState.origin.x;
    const deltaY = pointerDownState.lastCoords.y - pointerDownState.origin.y;
    const hasDragged = Math.abs(deltaX) >= 8 || Math.abs(deltaY) >= 8;

    if (hasDragged) {
      insertAgentInstructionBox({
        x: Math.min(pointerDownState.origin.x, pointerDownState.lastCoords.x),
        y: Math.min(pointerDownState.origin.y, pointerDownState.lastCoords.y),
        width: Math.max(180, Math.abs(deltaX)),
        height: Math.max(96, Math.abs(deltaY)),
      });
    } else {
      insertAgentInstructionAt(pointerDownState.origin.x, pointerDownState.origin.y);
    }

    setIsAgentInstructionMode(false);
  }, [insertAgentInstructionAt, insertAgentInstructionBox, isAgentInstructionMode]);

  return {
    addAgentInstruction,
    api,
    agentFooterState,
    binding,
    isAgentInstructionMode,
    onChange,
    onPointerUp,
    setApi,
    status,
    toggleAgentInstructionMode,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isEditingText(appState: AppState): boolean {
  return Boolean((appState as AppState & { editingTextElement?: unknown }).editingTextElement);
}

function getElementId(element: Record<string, unknown>): string {
  return typeof element.id === "string" ? element.id : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
