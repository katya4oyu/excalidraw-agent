import { useCallback, useEffect, useState, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useParams } from "react-router";
import { Excalidraw, Footer, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { generateKeyBetween } from "fractional-indexing";
import { getNoteEmbedMetadata, type AgentStatus } from "@excalidraw-agent/shared";
import { getCodexStatus, getFile, startAgentRun, type CodexStatusResponse } from "../api";
import { useExcalidrawCollab, type AgentPresenceState } from "../collab/useExcalidrawCollab";
import type { AgentFooterState } from "@excalidraw-agent/y-excalidraw-browser";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const canvasAgentPrompt = [
  "現在のExcalidrawキャンバス全体を確認してください。",
  "キャンバス上の図形、テキスト、Noteの内容を判断材料にして、必要な編集提案を作成してください。",
  "特定のNoteだけを実行対象にせず、キャンバス全体の文脈を優先してください。",
].join("\n");

const agentModelStorageKey = "excalidraw-agent:selected-model";
const defaultAgentModelLabel = "gpt-5.3";

export function FilePage() {
  const { id } = useParams();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => {
    return window.localStorage.getItem(agentModelStorageKey) ?? defaultAgentModelLabel;
  });
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatusResponse | null>(null);
  const [workerStatus, setWorkerStatus] = useState<AgentStatus | "unknown">("unknown");
  const {
    api,
    agentPresence,
    agentFooterState,
    agentSettings,
    approveLatestProposal,
    binding,
    isAgentInstructionMode,
    onChange,
    onPointerUp,
    rejectLatestProposal,
    setAutoModeEnabled,
    setApi,
    status,
    toggleAgentInstructionMode,
    viewportState,
  } = useExcalidrawCollab({
    fileId: id ?? "",
    excalidrawElement: shellRef.current,
  });

  const openFallbackImagePicker = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (!id) {
      return;
    }

    let isMounted = true;
    const refreshWorkerStatus = () => {
      void getFile(id)
        .then((file) => {
          if (isMounted) {
            setWorkerStatus(file.agentStatus);
          }
        })
        .catch(() => {
          if (isMounted) {
            setWorkerStatus("unknown");
          }
        });
    };

    refreshWorkerStatus();
    const interval = window.setInterval(refreshWorkerStatus, 2_000);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [id]);

  useEffect(() => {
    if (workerStatus === "unknown" || workerStatus === "starting") {
      setCodexStatus(null);
      return;
    }

    let isMounted = true;
    const refreshCodexStatus = () => {
      void getCodexStatus()
        .then((status) => {
          if (isMounted) {
            setCodexStatus(status);
          }
        })
        .catch((error) => {
          if (isMounted) {
            setCodexStatus({
              status: "error",
              authMethod: null,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
    };

    refreshCodexStatus();
    const interval = window.setInterval(refreshCodexStatus, 10_000);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [workerStatus]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const isImageToolEvent = (event: Event) => {
      const target = event.target;
      return target instanceof Element && Boolean(target.closest("label")?.querySelector("[data-testid='toolbar-image']"));
    };

    const handleImageToolPointerDown = (event: PointerEvent) => {
      if (!isImageToolEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      openFallbackImagePicker();
    };

    const handleImageToolClick = (event: MouseEvent) => {
      if (!isImageToolEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    shell.addEventListener("pointerdown", handleImageToolPointerDown, { capture: true });
    shell.addEventListener("click", handleImageToolClick, { capture: true });
    return () => {
      shell.removeEventListener("pointerdown", handleImageToolPointerDown, { capture: true });
      shell.removeEventListener("click", handleImageToolClick, { capture: true });
    };
  }, [openFallbackImagePicker]);

  if (!id) {
    return <main className="state-page">Missing file id</main>;
  }

  return (
    <main className="canvas-page">
      <div ref={shellRef} className="excalidraw-host">
        <input
          ref={imageInputRef}
          accept="image/*"
          className="agent-image-input"
          type="file"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file || !api) {
              return;
            }

            try {
              await insertImageFile(api, file);
            } catch (error) {
              console.error(error);
            }
          }}
        />
        <AgentPresenceOverlay
          presence={agentPresence}
          viewport={viewportState}
        />
        <Excalidraw
          excalidrawAPI={setApi}
          isCollaborating={Boolean(binding)}
          onChange={onChange}
          onLinkOpen={handleNoteLinkOpen}
          onPointerUp={onPointerUp}
          onPointerUpdate={binding?.onPointerUpdate}
          renderEmbeddable={renderNoteEmbeddable}
          validateEmbeddable={validateNoteEmbeddable}
        >
          <WelcomeScreen />
          <Footer>
            <AgentFooterTools
              agent={agentFooterState}
              agentPresence={agentPresence}
              codexStatus={codexStatus}
              collabStatus={status}
              isStartingRun={isStartingRun}
              isInstructionMode={isAgentInstructionMode}
              isAutoModeEnabled={agentSettings.autoModeEnabled}
              workerStatus={workerStatus}
              runError={runError}
              selectedModel={selectedModel}
              onApproveProposal={approveLatestProposal}
              onRejectProposal={rejectLatestProposal}
              onModelChange={(model) => {
                setSelectedModel(model);
                window.localStorage.setItem(agentModelStorageKey, model);
              }}
              onRunAgent={async () => {
                setRunError(null);
                setIsStartingRun(true);
                try {
                  await startAgentRun(id, canvasAgentPrompt);
                } catch (error) {
                  setRunError(error instanceof Error ? error.message : String(error));
                } finally {
                  setIsStartingRun(false);
                }
              }}
              onToggleAutoMode={() => setAutoModeEnabled(!agentSettings.autoModeEnabled)}
              onToggleInstructionMode={toggleAgentInstructionMode}
            />
          </Footer>
        </Excalidraw>
      </div>
    </main>
  );
}

function AgentPresenceOverlay({
  presence,
  viewport,
}: {
  presence: AgentPresenceState | null;
  viewport: {
    scrollX: number;
    scrollY: number;
    zoom: number;
  };
}) {
  if (!presence || presence.status !== "running") {
    return null;
  }

  const area = presence.plannedArea;
  const left = (area.x + viewport.scrollX) * viewport.zoom;
  const top = (area.y + viewport.scrollY) * viewport.zoom;
  const width = area.width * viewport.zoom;
  const height = area.height * viewport.zoom;
  const logs = presence.logs.length > 0 ? presence.logs : [presence.message];

  return (
    <div
      aria-hidden="true"
      className={`agent-presence-overlay agent-presence-overlay--${presence.status}`}
      style={{
        left,
        top,
        width,
        height,
      }}
    >
      <div className="agent-presence-overlay__label">
        <span className="agent-presence-overlay__dot" />
        <span className="agent-presence-overlay__title">Agent</span>
        <span className="agent-presence-overlay__message">{presence.message}</span>
      </div>
      <div className="agent-presence-overlay__logs">
        {logs.slice(-3).map((log, index) => (
          <span key={`${presence.runId}-${index}`}>{log}</span>
        ))}
      </div>
    </div>
  );
}

async function insertImageFile(api: ExcalidrawImperativeAPI, file: File): Promise<void> {
  if (!file.type.startsWith("image/")) {
    return;
  }

  const { dataURL, height: naturalHeight, width: naturalWidth } = await readImageFile(file);
  const fileId = crypto.randomUUID();
  const now = Date.now();

  const maxWidth = 640;
  const maxHeight = 480;
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  const width = Math.max(1, naturalWidth * scale);
  const height = Math.max(1, naturalHeight * scale);
  const appState = api.getAppState();
  const zoom = appState.zoom.value;
  const x = -appState.scrollX + (appState.width / zoom - width) / 2;
  const y = -appState.scrollY + (appState.height / zoom - height) / 2;
  const elements = api.getSceneElements();
  const id = crypto.randomUUID();
  const index = generateKeyBetween(getLastElementIndex(elements), null);

  api.addFiles([
    {
      created: now,
      dataURL: dataURL as never,
      id: fileId as never,
      lastRetrieved: now,
      mimeType: file.type as never,
    },
  ]);
  api.updateScene({
    elements: [
      ...elements,
      {
        id,
        type: "image",
        x,
        y,
        width,
        height,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
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
        fileId,
        status: "saved",
        scale: [1, 1],
        crop: null,
        index,
      } as never,
    ],
    appState: {
      selectedElementIds: {
        [id]: true,
      },
    },
  });
  api.setActiveTool({ type: "selection" });
  api.resetCursor();
}

function readImageFile(file: File): Promise<{ dataURL: string; height: number; width: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read image"));
        return;
      }

      const image = new Image();
      image.onerror = () => reject(new Error("Failed to load image"));
      image.onload = () => {
        resolve({
          dataURL: reader.result as string,
          height: image.naturalHeight || image.height,
          width: image.naturalWidth || image.width,
        });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getLastElementIndex(elements: readonly Record<string, unknown>[]): string | null {
  const indexes = elements
    .map((element) => element.index)
    .filter((index): index is string => typeof index === "string")
    .sort();
  return indexes.at(-1) ?? null;
}

function renderNoteEmbeddable(element: Record<string, unknown>) {
  if (!getNoteEmbedMetadata(element) || typeof element.link !== "string" || !validateNoteEmbeddable(element.link)) {
    return null;
  }

  return (
    <iframe
      allow="clipboard-write"
      allowFullScreen
      className="excalidraw__embeddable"
      referrerPolicy="no-referrer-when-downgrade"
      sandbox="allow-same-origin allow-scripts allow-forms"
      scrolling="no"
      src={element.link}
      title="Note"
    />
  );
}

function handleNoteLinkOpen(
  element: Record<string, unknown>,
  event: CustomEvent<{ nativeEvent: MouseEvent | ReactPointerEvent<HTMLCanvasElement> }>,
): void {
  if (getNoteEmbedMetadata(element)) {
    event.preventDefault();
  }
}

function validateNoteEmbeddable(link: string): boolean {
  try {
    const url = new URL(link);
    return url.origin === window.location.origin && (url.pathname === "/note" || url.pathname === "/note.html");
  } catch {
    return false;
  }
}

function AgentFooterTools({
  agent,
  agentPresence,
  codexStatus,
  collabStatus,
  isStartingRun,
  isInstructionMode,
  isAutoModeEnabled,
  onModelChange,
  onApproveProposal,
  onRejectProposal,
  onRunAgent,
  onToggleAutoMode,
  onToggleInstructionMode,
  runError,
  selectedModel,
  workerStatus,
}: {
  agent: AgentFooterState;
  agentPresence: AgentPresenceState | null;
  codexStatus: CodexStatusResponse | null;
  collabStatus: string;
  isStartingRun: boolean;
  isInstructionMode: boolean;
  isAutoModeEnabled: boolean;
  onModelChange: (model: string) => void;
  onApproveProposal: () => boolean;
  onRejectProposal: () => boolean;
  onRunAgent: () => void;
  onToggleAutoMode: () => void;
  onToggleInstructionMode: () => void;
  runError: string | null;
  selectedModel: string;
  workerStatus: AgentStatus | "unknown";
}) {
  const label = toAgentFooterLabel(agent);
  const codexStatusLabel = toCodexStatusLabel(codexStatus);
  const codexWarning = toCodexWarning(codexStatus);
  const runProgressLog = isAgentRunActive(agent) ? getLatestAgentLog(agentPresence) : null;
  const workerStatusLabel = toWorkerStatusLabel(workerStatus);
  const runDisabledReason = isStartingRun ? "Agent is starting" : isAgentRunActive(agent) ? "Agent is already running" : null;
  const isRunDisabled = Boolean(runDisabledReason);
  const hasProposal = agent.proposedCount > 0 || agent.ghostElementCount > 0;
  const statusTitle = [
    label,
    runProgressLog ? `Progress: ${runProgressLog}` : "",
    agent.ghostElementCount > 0 ? `${agent.ghostElementCount} ghost proposal${agent.ghostElementCount === 1 ? "" : "s"}` : "",
    `Codex: ${codexStatusLabel}`,
    codexStatus?.message ? `Codex message: ${codexStatus.message}` : "",
    codexWarning ? `Codex warning: ${codexWarning}` : "",
    `Worker: ${workerStatusLabel}`,
    `Collab: ${collabStatus}`,
    runDisabledReason ? `Run disabled: ${runDisabledReason}` : "",
    runError ? `Last run failed: ${runError}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="agent-footer-tools" aria-label={`Agent tools. ${statusTitle}`}>
      <span className="agent-footer-tools__status" title={statusTitle}>
        <span
          className={`agent-footer-tools__dot agent-footer-tools__dot--${runError ? "failed" : agent.runStatus}`}
          aria-hidden="true"
        />
      </span>
      <span className="agent-footer-tools__text" title={statusTitle}>
        {runProgressLog ?? `worker ${workerStatusLabel}`}
      </span>
      {codexWarning ? (
        <span className="agent-footer-tools__warning" title={codexWarning}>
          {codexWarning}
        </span>
      ) : null}
      <span className="agent-footer-tools__separator" aria-hidden="true" />
      <label className="agent-footer-tools__model" title="Model selection is UI-only in this version">
        <span className="agent-footer-tools__model-text">
          <select
            aria-label="Agent model"
            className="agent-footer-tools__select"
            value={selectedModel}
            onChange={(event) => onModelChange(event.currentTarget.value)}
          >
            <option value="gpt-5.3">gpt-5.3</option>
            <option value="gpt-5.3-codex-spark">spark</option>
          </select>
          <ChevronDownIcon />
        </span>
      </label>
      <button
        aria-label={isInstructionMode ? "Cancel note placement" : "Place note"}
        aria-pressed={isInstructionMode}
        className="agent-footer-tools__button"
        title={isInstructionMode ? "Cancel note placement" : "Place note"}
        type="button"
        onClick={onToggleInstructionMode}
      >
        <MessageCircleIcon />
      </button>
      <button
        aria-label={runDisabledReason ?? "Run Agent"}
        className="agent-footer-tools__button agent-footer-tools__button--run"
        disabled={isRunDisabled}
        title={runDisabledReason ?? "Run Agent"}
        type="button"
        onClick={onRunAgent}
      >
        <PlayerPlayIcon />
        <span>Run</span>
      </button>
      <button
        aria-label={isAutoModeEnabled ? "Disable Auto mode" : "Enable Auto mode"}
        aria-pressed={isAutoModeEnabled}
        className="agent-footer-tools__button"
        title={isAutoModeEnabled ? "Auto mode on" : "Auto mode off"}
        type="button"
        onClick={onToggleAutoMode}
      >
        <RefreshIcon />
      </button>
      {hasProposal ? (
        <>
          <button
            aria-label="Approve agent proposal"
            className="agent-footer-tools__button agent-footer-tools__button--approve"
            title="Approve proposal"
            type="button"
            onClick={onApproveProposal}
          >
            <CheckIcon />
          </button>
          <button
            aria-label="Reject agent proposal"
            className="agent-footer-tools__button agent-footer-tools__button--reject"
            title="Reject proposal"
            type="button"
            onClick={onRejectProposal}
          >
            <XIcon />
          </button>
        </>
      ) : null}
      <button
        aria-label="More agent tools"
        className="agent-footer-tools__button"
        disabled
        title="More agent tools"
        type="button"
      >
        <DotsIcon />
      </button>
    </div>
  );
}

function toAgentFooterLabel(agent: AgentFooterState): string {
  if (agent.runStatus === "idle") {
    return "Agent idle";
  }

  if (agent.runStatus === "proposed") {
    return agent.proposedCount > 0 ? `Agent proposal ${agent.proposedCount}` : "Agent proposal";
  }

  if (agent.activeRunCount > 1) {
    return `Agent ${agent.runStatus} ${agent.activeRunCount}`;
  }

  return `Agent ${agent.runStatus}`;
}

function toCodexStatusLabel(status: CodexStatusResponse | null): string {
  if (!status) {
    return "checking";
  }

  const authMethod = toCodexAuthMethodLabel(status.authMethod);
  return authMethod ? `${status.status} · ${authMethod}` : status.status;
}

function toWorkerStatusLabel(status: AgentStatus | "unknown"): string {
  return status === "idle" ? "ready" : status;
}

function toCodexWarning(status: CodexStatusResponse | null): string | null {
  if (!status) {
    return null;
  }

  if (status.status === "available") {
    return null;
  }

  return status.message ?? (status.status === "not_logged_in" ? "Codex is not logged in" : "Codex status error");
}

function toCodexAuthMethodLabel(authMethod: CodexStatusResponse["authMethod"]): string | null {
  if (!authMethod) {
    return null;
  }

  if (authMethod === "api_key") {
    return "API key";
  }

  if (authMethod === "access_token") {
    return "access token";
  }

  if (authMethod === "chatgpt") {
    return "ChatGPT";
  }

  return authMethod;
}

function getLatestAgentLog(presence: AgentPresenceState | null): string | null {
  if (!presence) {
    return null;
  }

  return presence.logs.at(-1) ?? presence.message;
}

function isAgentRunActive(agent: AgentFooterState): boolean {
  return agent.activeRunCount > 0 || agent.runStatus === "queued" || agent.runStatus === "running" || agent.runStatus === "applying";
}

function createToolbarIcon(children: ReactNode) {
  return (
    <svg
      aria-hidden="true"
      className="agent-footer-tools__icon"
      focusable="false"
      role="img"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

// tabler-icons: chevron-down
function ChevronDownIcon() {
  return createToolbarIcon(
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
      <path d="M6 9l6 6l6 -6" />
    </g>,
  );
}

// tabler-icons: message-circle
function MessageCircleIcon() {
  return createToolbarIcon(
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
      <path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1" />
    </g>,
  );
}

// tabler-icons: player-play
function PlayerPlayIcon() {
  return createToolbarIcon(
    <path d="M7 5v14l11 -7z" fill="currentColor" />,
  );
}

// tabler-icons: refresh
function RefreshIcon() {
  return createToolbarIcon(
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5">
      <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </g>,
  );
}

// tabler-icons: check
function CheckIcon() {
  return createToolbarIcon(
    <path
      d="M5 12l5 5l10 -10"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
    />,
  );
}

// tabler-icons: x
function XIcon() {
  return createToolbarIcon(
    <path
      d="M18 6l-12 12M6 6l12 12"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
    />,
  );
}

// tabler-icons: dots
function DotsIcon() {
  return createToolbarIcon(
    <g fill="currentColor">
      <circle cx="5" cy="12" r="1.35" />
      <circle cx="12" cy="12" r="1.35" />
      <circle cx="19" cy="12" r="1.35" />
    </g>,
  );
}
