import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  createAgentRunRequest,
  defaultAgentSettings,
  createBaseRevisionSnapshot,
  createNoteEmbedElement,
  createNoteRecord,
  getAgentInstructionPrompt,
  getNoteEmbedMetadata,
  insertExcalidrawElements,
  toDocumentName,
  type AgentSettings,
  type NoteRecord,
  type NoteToParentMessage,
  type ParentToNoteMessage,
} from "@excalidraw-agent/shared";
import {
  approveAgentProposal,
  createAgentFooterStateObserver,
  ExcalidrawBinding,
  rejectAgentProposal,
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

export interface AgentPresenceState {
  schemaVersion: 1;
  fileId: string;
  runId: string;
  requestId: string;
  status: "running" | "proposed" | "failed";
  message: string;
  logs: string[];
  plannedArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  updatedAt: number;
}

export function useExcalidrawCollab({ fileId, excalidrawElement }: UseExcalidrawCollabOptions) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState("connecting");
  const [binding, setBinding] = useState<ExcalidrawBinding | null>(null);
  const [isAgentInstructionMode, setIsAgentInstructionMode] = useState(false);
  const [agentPresence, setAgentPresence] = useState<AgentPresenceState | null>(null);
  const [viewportState, setViewportState] = useState<{
    scrollX: number;
    scrollY: number;
    zoom: number;
  }>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const viewportStateRef = useRef({ scrollX: 0, scrollY: 0, zoom: 1 });
  const ydocRef = useRef<Y.Doc | null>(null);
  const requestedInstructionPromptsRef = useRef(new Map<string, string>());
  const autoIdleTimerRef = useRef<number>(0);
  const lastAutoSceneSignatureRef = useRef<string | null>(null);
  const suppressNextAutoChangeRef = useRef(false);
  const noteWindowsRef = useRef(new Map<string, Window>());
  const proposalStoresRef = useRef<{
    elements: Y.Array<Y.Map<unknown>>;
    agentRuns: Y.Map<unknown>;
    agentProposals: Y.Map<unknown>;
  } | null>(null);
  const [agentFooterState, setAgentFooterState] = useState<AgentFooterState>({
    runStatus: "idle",
    activeRunCount: 0,
    proposedCount: 0,
    ghostElementCount: 0,
  });
  const agentFooterStateRef = useRef(agentFooterState);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => defaultAgentSettings());

  useEffect(() => {
    agentFooterStateRef.current = agentFooterState;
  }, [agentFooterState]);

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
    const yAgentSettings = ydoc.getMap("agentSettings");
    const yNotes = ydoc.getMap<Record<string, unknown>>("notes");
    proposalStoresRef.current = {
      elements: yElements,
      agentRuns: yAgentRuns,
      agentProposals: yAgentProposals,
    };
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
    const handleAwarenessChange = () => {
      setAgentPresence(readAgentPresence(awareness, fileId));
    };

    provider.on("status", handleStatus);
    awareness.on("change", handleAwarenessChange);
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
    const sendNoteState = (noteId: string, target: Window) => {
      const note = readNoteState(ydoc, fileId, noteId);
      if (!note) {
        return;
      }

      target.postMessage(
        {
          type: "excalidraw-agent:noteState",
          fileId,
          note,
        } satisfies ParentToNoteMessage,
        window.location.origin,
      );
    };
    const sendAllNoteStates = () => {
      for (const [noteId, target] of noteWindowsRef.current.entries()) {
        sendNoteState(noteId, target);
      }
    };
    const handleNoteMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !isNoteToParentMessage(event.data)) {
        return;
      }

      const source = event.source;
      if (event.data.fileId !== fileId || !isWindowMessageSource(source)) {
        return;
      }

      noteWindowsRef.current.set(event.data.noteId, source);
      if (event.data.type === "excalidraw-agent:noteReady") {
        sendNoteState(event.data.noteId, source);
        return;
      }

      if (event.data.type === "excalidraw-agent:noteTextChanged") {
        updateNoteText(ydoc, fileId, event.data.noteId, event.data.text);
        sendNoteState(event.data.noteId, source);
      }
    };
    const observeNoteState = () => {
      sendAllNoteStates();
    };
    const emitAgentSettings = () => {
      const current = readAgentSettings(yAgentSettings);
      setAgentSettings(current);
      if (!current.autoModeEnabled && autoIdleTimerRef.current) {
        window.clearTimeout(autoIdleTimerRef.current);
        autoIdleTimerRef.current = 0;
      }
    };
    window.addEventListener("message", handleNoteMessage);
    yNotes.observe(observeNoteState);
    yAgentRuns.observe(observeNoteState);
    yAgentSettings.observe(emitAgentSettings);
    emitAgentSettings();

    return () => {
      setBinding(null);
      ydocRef.current = null;
      proposalStoresRef.current = null;
      setAgentPresence(null);
      requestedInstructionPromptsRef.current.clear();
      noteWindowsRef.current.clear();
      setAgentFooterState({
        runStatus: "idle",
        activeRunCount: 0,
        proposedCount: 0,
        ghostElementCount: 0,
      });
      yNotes.unobserve(observeNoteState);
      yAgentRuns.unobserve(observeNoteState);
      yAgentSettings.unobserve(emitAgentSettings);
      if (autoIdleTimerRef.current) {
        window.clearTimeout(autoIdleTimerRef.current);
        autoIdleTimerRef.current = 0;
      }
      window.removeEventListener("message", handleNoteMessage);
      destroyAgentFooterStateObserver();
      provider.off("status", handleStatus);
      provider.off("synced", handleSynced);
      awareness.off("change", handleAwarenessChange);
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

  useEffect(() => {
    if (!api || !excalidrawElement) {
      return;
    }

    let wheelPanTimer = 0;
    const clearWheelPanMode = () => {
      excalidrawElement.classList.remove("note-wheel-pan-active");
      wheelPanTimer = 0;
    };
    const handleWheel = (event: WheelEvent) => {
      if (isEventInsideNoteIframe(event)) {
        return;
      }

      if (!hasActiveOrSelectedNote(api)) {
        return;
      }

      window.clearTimeout(wheelPanTimer);
      excalidrawElement.classList.add("note-wheel-pan-active");
      wheelPanTimer = window.setTimeout(clearWheelPanMode, 180);
    };

    excalidrawElement.addEventListener("wheel", handleWheel, { capture: true });

    return () => {
      window.clearTimeout(wheelPanTimer);
      clearWheelPanMode();
      excalidrawElement.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [api, excalidrawElement]);

  const insertAgentInstructionAt = useCallback((x: number, y: number) => {
    if (!ydocRef.current) {
      return;
    }

    const noteId = `note-${crypto.randomUUID()}`;
    const width = 420;
    const height = 220;
    const link = createNoteEmbedLink(fileId, noteId);
    ydocRef.current.getMap<Record<string, unknown>>("notes").set(
      noteId,
      toRecord(createNoteRecord(fileId, noteId)),
    );
    insertExcalidrawElements(
      ydocRef.current,
      [
        createNoteEmbedElement({
          fileId,
          height,
          link,
          noteId,
          width,
          x,
          y,
        }),
      ],
    );
  }, [fileId]);

  const insertAgentInstructionBox = useCallback((input: {
    height?: number;
    width?: number;
    x: number;
    y: number;
  }) => {
    if (!ydocRef.current) {
      return;
    }

    const noteId = `note-${crypto.randomUUID()}`;
    const width = Math.max(280, input.width ?? 420);
    const height = Math.max(160, input.height ?? 220);
    const link = createNoteEmbedLink(fileId, noteId);
    ydocRef.current.getMap<Record<string, unknown>>("notes").set(
      noteId,
      toRecord(createNoteRecord(fileId, noteId)),
    );
    insertExcalidrawElements(
      ydocRef.current,
      [
        createNoteEmbedElement({
          fileId,
          height,
          link,
          noteId,
          width,
          x: input.x,
          y: input.y,
        }),
      ],
    );
  }, [fileId]);

  const addAgentInstruction = useCallback(() => {
    if (!api) {
      return;
    }

    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const elementWidth = 420;
    const elementHeight = 220;
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

  const approveLatestProposal = useCallback(() => {
    const stores = proposalStoresRef.current;
    const ydoc = ydocRef.current;
    if (!stores || !ydoc) {
      return false;
    }

    suppressNextAutoChangeRef.current = true;
    const proposalId = getLatestProposedProposalId(stores.agentProposals);
    if (!proposalId) {
      return false;
    }

    const approved = approveAgentProposal(stores, proposalId);
    syncRunRequestStatusFromProposal(ydoc, stores.agentProposals, proposalId);
    return approved;
  }, []);

  const rejectLatestProposal = useCallback(() => {
    const stores = proposalStoresRef.current;
    const ydoc = ydocRef.current;
    if (!stores || !ydoc) {
      return false;
    }

    suppressNextAutoChangeRef.current = true;
    const proposalId = getLatestProposedProposalId(stores.agentProposals);
    if (!proposalId) {
      return false;
    }

    const rejected = rejectAgentProposal(stores, proposalId);
    syncRunRequestStatusFromProposal(ydoc, stores.agentProposals, proposalId);
    return rejected;
  }, []);

  const setAutoModeEnabled = useCallback((enabled: boolean) => {
    if (!ydocRef.current) {
      return;
    }

    const now = Date.now();
    const settings = ydocRef.current.getMap("agentSettings");
    settings.set("schemaVersion", 1);
    settings.set("autoModeEnabled", enabled);
    settings.set("autoIdleMs", readAutoIdleMs(settings));
    settings.set("updatedAt", now);
  }, []);

  const onChange = useCallback((elements: readonly Record<string, unknown>[], appState: AppState) => {
    const nextViewportState = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    };
    if (
      viewportStateRef.current.scrollX !== nextViewportState.scrollX ||
      viewportStateRef.current.scrollY !== nextViewportState.scrollY ||
      viewportStateRef.current.zoom !== nextViewportState.zoom
    ) {
      viewportStateRef.current = nextViewportState;
      setViewportState(nextViewportState);
    }

    if (isEditingText(appState) || !ydocRef.current) {
      return;
    }

    restoreManagedNoteLinks(ydocRef.current, fileId, elements);
    scheduleAutoIdleRunIfNeeded(ydocRef.current, fileId, elements, {
      agentFooterState: agentFooterStateRef.current,
      autoIdleTimerRef,
      lastAutoSceneSignatureRef,
      suppressNextAutoChangeRef,
    });

    const requests = ydocRef.current.getMap<Record<string, unknown>>("agentRunRequests");
    const legacyRequests = ydocRef.current.getMap<Record<string, unknown>>("agentInstructionRequests");
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
      const request = {
        ...createAgentRunRequest({
          fileId,
          prompt,
          source: "instruction-note",
          trigger: { type: "instruction-note" },
          now,
        }),
        prompt,
        elementId,
      };
      requests.set(elementId, request);
      legacyRequests.set(elementId, request);
      requestedInstructionPromptsRef.current.set(elementId, prompt);
    }
  }, [fileId]);

  const onPointerUp = useCallback((
    _activeTool: AppState["activeTool"],
    pointerDownState: PointerDownState,
  ) => {
    const deltaX = pointerDownState.lastCoords.x - pointerDownState.origin.x;
    const deltaY = pointerDownState.lastCoords.y - pointerDownState.origin.y;
    const hasDragged = Math.abs(deltaX) >= 8 || Math.abs(deltaY) >= 8;

    if (!isAgentInstructionMode) {
      if (!api || hasDragged) {
        return;
      }

      const note = findNoteElementAt(api.getSceneElements(), pointerDownState.lastCoords.x, pointerDownState.lastCoords.y);
      if (!note) {
        return;
      }

      api.updateScene({
        appState: {
          activeEmbeddable: {
            element: note as AppState["activeEmbeddable"] extends { element: infer Element } ? Element : never,
            state: "active",
          },
          selectedElementIds: {
            [note.id]: true,
          },
        },
      });
      window.setTimeout(() => {
        focusNoteTextarea(note);
      }, 0);
      window.setTimeout(() => {
        focusNoteTextarea(note);
      }, 60);
      return;
    }

    if (hasDragged) {
      insertAgentInstructionBox({
        x: Math.min(pointerDownState.origin.x, pointerDownState.lastCoords.x),
        y: Math.min(pointerDownState.origin.y, pointerDownState.lastCoords.y),
        width: Math.max(180, Math.abs(deltaX)),
        height: Math.max(96, Math.abs(deltaY)),
      });
    } else {
      insertAgentInstructionAt(pointerDownState.origin.x - 210, pointerDownState.origin.y - 110);
    }

    setIsAgentInstructionMode(false);
  }, [api, insertAgentInstructionAt, insertAgentInstructionBox, isAgentInstructionMode]);

  return {
    addAgentInstruction,
    api,
    agentPresence,
    agentFooterState,
    agentSettings,
    binding,
    isAgentInstructionMode,
    onChange,
    onPointerUp,
    approveLatestProposal,
    rejectLatestProposal,
    setAutoModeEnabled,
    setApi,
    status,
    toggleAgentInstructionMode,
    viewportState,
  };
}

function getLatestProposedProposalId(agentProposals: Y.Map<unknown>): string | null {
  let latest: { id: string; createdAt: number } | null = null;
  for (const [id, proposal] of agentProposals.entries()) {
    if (!isRecord(proposal) || proposal.status !== "proposed") {
      continue;
    }

    const createdAt = typeof proposal.createdAt === "number" ? proposal.createdAt : 0;
    if (!latest || createdAt >= latest.createdAt) {
      latest = { id, createdAt };
    }
  }

  return latest?.id ?? null;
}

function syncRunRequestStatusFromProposal(
  ydoc: Y.Doc,
  agentProposals: Y.Map<unknown>,
  proposalId: string,
): void {
  const proposal = agentProposals.get(proposalId);
  if (!isRecord(proposal)) {
    return;
  }

  const requestStatus = toRunRequestStatus(proposal.status);
  if (!requestStatus) {
    return;
  }

  const runId = typeof proposal.runId === "string" ? proposal.runId : proposalId;
  const now = typeof proposal.updatedAt === "number" ? proposal.updatedAt : Date.now();
  ydoc.transact(() => {
    for (const mapName of ["agentRunRequests", "agentInstructionRequests"]) {
      const requests = ydoc.getMap<Record<string, unknown>>(mapName);
      for (const [requestId, request] of requests.entries()) {
        if (!isRecord(request) || request.runId !== runId) {
          continue;
        }

        requests.set(requestId, {
          ...request,
          status: requestStatus,
          updatedAt: now,
        });
      }
    }
  });
}

function toRunRequestStatus(status: unknown): "applied" | "rejected" | "stale" | "failed" | null {
  if (status === "approved") {
    return "applied";
  }
  if (status === "rejected" || status === "stale") {
    return status;
  }
  if (status === "conflicted") {
    return "failed";
  }
  return null;
}

function readAgentSettings(settings: Y.Map<unknown>): AgentSettings {
  const fallback = defaultAgentSettings();
  return {
    schemaVersion: 1,
    autoModeEnabled: settings.get("autoModeEnabled") === true,
    autoIdleMs: readAutoIdleMs(settings),
    updatedAt: typeof settings.get("updatedAt") === "number" ? settings.get("updatedAt") as number : fallback.updatedAt,
  };
}

function readAutoIdleMs(settings: Y.Map<unknown>): number {
  const value = settings.get("autoIdleMs");
  return typeof value === "number" && value >= 1_000 ? value : 30_000;
}

function scheduleAutoIdleRunIfNeeded(
  ydoc: Y.Doc,
  fileId: string,
  elements: readonly Record<string, unknown>[],
  refs: {
    agentFooterState: AgentFooterState;
    autoIdleTimerRef: MutableRefObject<number>;
    lastAutoSceneSignatureRef: MutableRefObject<string | null>;
    suppressNextAutoChangeRef: MutableRefObject<boolean>;
  },
): void {
  const signature = createHumanSceneSignature(elements);
  if (refs.lastAutoSceneSignatureRef.current === null) {
    refs.lastAutoSceneSignatureRef.current = signature;
    return;
  }

  if (refs.lastAutoSceneSignatureRef.current === signature) {
    return;
  }
  refs.lastAutoSceneSignatureRef.current = signature;

  if (refs.suppressNextAutoChangeRef.current) {
    refs.suppressNextAutoChangeRef.current = false;
    return;
  }

  const settings = readAgentSettings(ydoc.getMap("agentSettings"));
  if (!settings.autoModeEnabled || isFooterRunActive(refs.agentFooterState) || hasPendingProposal(refs.agentFooterState)) {
    return;
  }

  const requests = ydoc.getMap<Record<string, unknown>>("agentRunRequests");
  if (hasActiveRunRequest(requests)) {
    return;
  }

  if (refs.autoIdleTimerRef.current) {
    window.clearTimeout(refs.autoIdleTimerRef.current);
  }

  const changedElementIds = elements
    .filter((element) => element.isDeleted !== true && typeof element.id === "string" && !isAgentGhostLikeElement(element))
    .map((element) => String(element.id));
  refs.autoIdleTimerRef.current = window.setTimeout(() => {
    refs.autoIdleTimerRef.current = 0;
    if (hasActiveRunRequest(requests) || isFooterRunActive(refs.agentFooterState) || hasPendingProposal(refs.agentFooterState)) {
      return;
    }

    const now = Date.now();
    const snapshot = createBaseRevisionSnapshot({
      elements: elements.filter((element) => !isAgentGhostLikeElement(element)),
      assets: ydoc.getMap("assets").toJSON() as Record<string, unknown>,
      notes: ydoc.getMap("notes").toJSON() as Record<string, unknown>,
    });
    requests.set(`auto-idle-${crypto.randomUUID()}`, createAgentRunRequest({
      fileId,
      prompt: [
        "現在の図を見て、小さな改善proposalを1つ作ってください。",
        "不要なら変更を作らず、その理由だけを述べてください。",
        "大規模な再構成は避け、add中心の提案にしてください。",
      ].join("\n"),
      source: "auto-idle",
      trigger: {
        type: "idle-after-edit",
        idleMs: settings.autoIdleMs,
        changedElementIds,
      },
      baseRevision: snapshot.hash,
      now,
    }) as unknown as Record<string, unknown>);
  }, settings.autoIdleMs);
}

function createHumanSceneSignature(elements: readonly Record<string, unknown>[]): string {
  return JSON.stringify(
    elements
      .filter((element) => element.isDeleted !== true && typeof element.id === "string" && !isAgentGhostLikeElement(element))
      .map((element) => ({
        id: element.id,
        version: element.version,
        versionNonce: element.versionNonce,
        updated: element.updated,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
}

function hasActiveRunRequest(requests: Y.Map<Record<string, unknown>>): boolean {
  for (const request of requests.values()) {
    if (isRecord(request) && (request.status === "queued" || request.status === "running" || request.status === "proposed")) {
      return true;
    }
  }
  return false;
}

function hasPendingProposal(agent: AgentFooterState): boolean {
  return agent.proposedCount > 0 || agent.ghostElementCount > 0 || agent.runStatus === "proposed";
}

function isFooterRunActive(agent: AgentFooterState): boolean {
  return agent.activeRunCount > 0 || agent.runStatus === "queued" || agent.runStatus === "running" || agent.runStatus === "applying";
}

function isAgentGhostLikeElement(element: Record<string, unknown>): boolean {
  const customData = element.customData;
  if (!isRecord(customData)) {
    return false;
  }
  const metadata = customData.excalidrawAgent;
  return isRecord(metadata) && metadata.schemaVersion === 1 && metadata.kind === "ghost";
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

function isEventInsideNoteIframe(event: Event): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof HTMLIFrameElement && isNoteIframe(target));
}

function isNoteIframe(iframe: HTMLIFrameElement): boolean {
  try {
    const src = new URL(iframe.src);
    return src.origin === window.location.origin && (src.pathname === "/note" || src.pathname === "/note.html");
  } catch {
    return false;
  }
}

function hasActiveOrSelectedNote(api: ExcalidrawImperativeAPI): boolean {
  const appState = api.getAppState();
  const activeElement = appState.activeEmbeddable?.element;
  if (activeElement && getNoteEmbedMetadata(activeElement as Record<string, unknown>)) {
    return true;
  }

  const selectedElementIds = appState.selectedElementIds;
  if (Object.keys(selectedElementIds).length === 0) {
    return false;
  }

  return api
    .getSceneElements()
    .some((element) => selectedElementIds[element.id] && getNoteEmbedMetadata(element as Record<string, unknown>));
}

function findNoteElementAt(
  elements: readonly Record<string, unknown>[],
  x: number,
  y: number,
): (Record<string, unknown> & { id: string }) | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    const metadata = getNoteEmbedMetadata(element);
    if (
      !metadata ||
      !isElementVisible(element) ||
      typeof element.id !== "string" ||
      typeof element.x !== "number" ||
      typeof element.y !== "number" ||
      typeof element.width !== "number" ||
      typeof element.height !== "number"
    ) {
      continue;
    }

    if (
      x >= element.x &&
      x <= element.x + element.width &&
      y >= element.y &&
      y <= element.y + element.height
    ) {
      return element as Record<string, unknown> & { id: string };
    }
  }

  return null;
}

function focusNoteTextarea(element: Record<string, unknown>): void {
  const metadata = getNoteEmbedMetadata(element);
  if (!metadata) {
    return;
  }

  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe.excalidraw__embeddable[src*="noteId=${metadata.noteId}"]`,
  );
  const textarea = iframe?.contentWindow?.document.querySelector<HTMLTextAreaElement>("textarea");
  textarea?.focus();
}

function isElementVisible(element: Record<string, unknown>): boolean {
  return element.isDeleted !== true && element.type === "embeddable";
}

function createNoteEmbedLink(fileId: string, noteId: string): string {
  const url = new URL("/note", window.location.origin);
  url.searchParams.set("fileId", fileId);
  url.searchParams.set("noteId", noteId);
  return url.toString();
}

function restoreManagedNoteLinks(
  ydoc: Y.Doc,
  fileId: string,
  elements: readonly Record<string, unknown>[],
): void {
  const changedNoteLinks = new Map<string, string>();
  for (const element of elements) {
    const metadata = getNoteEmbedMetadata(element);
    if (!metadata || metadata.fileId !== fileId || typeof element.id !== "string") {
      continue;
    }

    const expectedLink = createNoteEmbedLink(metadata.fileId, metadata.noteId);
    if (element.link !== expectedLink) {
      changedNoteLinks.set(element.id, expectedLink);
    }
  }

  if (changedNoteLinks.size === 0) {
    return;
  }

  for (const item of ydoc.getArray<Y.Map<unknown>>("elements").toArray()) {
    const element = item.get("el");
    if (!isRecord(element) || typeof element.id !== "string") {
      continue;
    }

    const expectedLink = changedNoteLinks.get(element.id);
    if (expectedLink) {
      item.set("el", {
        ...element,
        link: expectedLink,
      });
    }
  }
}

function readNoteState(ydoc: Y.Doc, fileId: string, noteId: string): NoteRecord | null {
  const note = ydoc.getMap<Record<string, unknown>>("notes").get(noteId);
  if (!isNoteRecord(note)) {
    const elementMetadata = findNoteEmbedMetadata(ydoc, fileId, noteId);
    if (!elementMetadata || typeof elementMetadata.text !== "string") {
      return null;
    }

    const now = Date.now();
    return {
      ...createNoteRecord(fileId, noteId, now),
      text: elementMetadata.text,
      updatedAt: now,
    };
  }

  const request = typeof note.requestId === "string"
    ? ydoc.getMap<Record<string, unknown>>("agentRunRequests").get(note.requestId) ??
      ydoc.getMap<Record<string, unknown>>("agentInstructionRequests").get(note.requestId) ??
      null
    : null;
  const runId = typeof note.runId === "string"
    ? note.runId
    : isRecord(request) && typeof request.runId === "string"
      ? request.runId
      : undefined;
  const run = runId ? ydoc.getMap<Record<string, unknown>>("agentRuns").get(runId) ?? null : null;

  return {
    ...note,
    fileId,
    noteId,
    runId,
    status: readNoteStatus(note, request, run),
  };
}

function findNoteEmbedMetadata(
  ydoc: Y.Doc,
  fileId: string,
  noteId: string,
): ReturnType<typeof getNoteEmbedMetadata> {
  for (const item of ydoc.getArray<Y.Map<unknown>>("elements").toArray()) {
    const metadata = getNoteEmbedMetadata(item.get("el"));
    if (metadata?.fileId === fileId && metadata.noteId === noteId) {
      return metadata;
    }
  }

  return null;
}

function updateNoteText(ydoc: Y.Doc, fileId: string, noteId: string, text: string): void {
  const notes = ydoc.getMap<Record<string, unknown>>("notes");
  const current = notes.get(noteId);
  const now = Date.now();
  const nextNote = {
    ...(isRecord(current) ? current : createNoteRecord(fileId, noteId, now)),
    schemaVersion: 1,
    fileId,
    noteId,
    text,
    status: readEditableNoteStatus(current),
    updatedAt: now,
  };

  ydoc.transact(() => {
    notes.set(noteId, nextNote);
    mirrorNoteTextToEmbedCustomData(ydoc, fileId, noteId, text);
  });
}

function mirrorNoteTextToEmbedCustomData(
  ydoc: Y.Doc,
  fileId: string,
  noteId: string,
  text: string,
): void {
  for (const item of ydoc.getArray<Y.Map<unknown>>("elements").toArray()) {
    const element = item.get("el");
    const metadata = getNoteEmbedMetadata(element);
    if (!isRecord(element) || metadata?.fileId !== fileId || metadata.noteId !== noteId) {
      continue;
    }

    const customData = isRecord(element.customData) ? element.customData : {};
    const excalidrawAgent = isRecord(customData.excalidrawAgent) ? customData.excalidrawAgent : {};
    item.set("el", {
      ...element,
      customData: {
        ...customData,
        excalidrawAgent: {
          ...excalidrawAgent,
          schemaVersion: 1,
          kind: "note-embed",
          fileId,
          noteId,
          text,
        },
      },
      updated: Date.now(),
      version: typeof element.version === "number" ? element.version + 1 : 1,
      versionNonce: Math.floor(Math.random() * 1_000_000),
    });
    return;
  }
}

function readNoteStatus(
  note: NoteRecord,
  request: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
): NoteRecord["status"] {
  if (isRecord(run) && isNoteStatus(run.status)) {
    return run.status;
  }

  if (isRecord(request) && isNoteStatus(request.status)) {
    return request.status;
  }

  if (isRecord(request) && request.status === "stale") {
    return "idle";
  }

  return note.status;
}

function readEditableNoteStatus(current: unknown): NoteRecord["status"] {
  if (!isRecord(current)) {
    return "idle";
  }

  const status = current.status;
  if (status === "queued" || status === "running") {
    return status;
  }

  return "idle";
}

function isNoteRecord(value: unknown): value is NoteRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.fileId === "string" &&
    typeof value.noteId === "string" &&
    typeof value.text === "string" &&
    isNoteStatus(value.status) &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isNoteStatus(value: unknown): value is NoteRecord["status"] {
  return (
    value === "idle" ||
    value === "queued" ||
    value === "running" ||
    value === "proposed" ||
    value === "conflicted" ||
    value === "failed"
  );
}

function isNoteToParentMessage(value: unknown): value is NoteToParentMessage {
  return (
    isRecord(value) &&
    typeof value.fileId === "string" &&
    typeof value.noteId === "string" &&
    (
      value.type === "excalidraw-agent:noteReady" ||
      (
        value.type === "excalidraw-agent:noteTextChanged" &&
        typeof value.text === "string"
      ) ||
      (
        value.type === "excalidraw-agent:noteResizeRequested" &&
        typeof value.width === "number" &&
        typeof value.height === "number"
      )
    )
  );
}

function isWindowMessageSource(source: MessageEventSource | null): source is Window {
  return (
    source !== null &&
    typeof (source as { postMessage?: unknown }).postMessage === "function" &&
    !("start" in source)
  );
}

function readAgentPresence(awareness: NonNullable<HocuspocusProvider["awareness"]>, fileId: string): AgentPresenceState | null {
  let latest: AgentPresenceState | null = null;
  for (const state of awareness.getStates().values()) {
    const presence = isRecord(state) ? state.agentPresence : null;
    if (!isAgentPresenceState(presence) || presence.fileId !== fileId) {
      continue;
    }

    if (!latest || presence.updatedAt > latest.updatedAt) {
      latest = presence;
    }
  }

  return latest;
}

function isAgentPresenceState(value: unknown): value is AgentPresenceState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.fileId === "string" &&
    typeof value.runId === "string" &&
    typeof value.requestId === "string" &&
    (
      value.status === "running" ||
      value.status === "proposed" ||
      value.status === "failed"
    ) &&
    typeof value.message === "string" &&
    Array.isArray(value.logs) &&
    value.logs.every((log) => typeof log === "string") &&
    isRecord(value.plannedArea) &&
    typeof value.plannedArea.x === "number" &&
    typeof value.plannedArea.y === "number" &&
    typeof value.plannedArea.width === "number" &&
    typeof value.plannedArea.height === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: NoteRecord): Record<string, unknown> {
  return { ...value };
}
