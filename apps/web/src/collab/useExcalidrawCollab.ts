import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  createNoteEmbedElement,
  createNoteRecord,
  getAgentInstructionPrompt,
  getNoteEmbedMetadata,
  insertExcalidrawElements,
  toDocumentName,
  type NoteRecord,
  type NoteToParentMessage,
  type ParentToNoteMessage,
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
  const noteWindowsRef = useRef(new Map<string, Window>());
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
    const yNotes = ydoc.getMap<Record<string, unknown>>("notes");
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
    window.addEventListener("message", handleNoteMessage);
    yNotes.observe(observeNoteState);
    yAgentRuns.observe(observeNoteState);

    return () => {
      setBinding(null);
      ydocRef.current = null;
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
    binding,
    isAgentInstructionMode,
    onChange,
    onPointerUp,
    setApi,
    status,
    toggleAgentInstructionMode,
    viewportState,
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
    ? ydoc.getMap<Record<string, unknown>>("agentInstructionRequests").get(note.requestId) ?? null
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
