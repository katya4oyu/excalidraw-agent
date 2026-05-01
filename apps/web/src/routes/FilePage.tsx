import { useState, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useParams } from "react-router";
import { Excalidraw, Footer, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { getNoteEmbedMetadata } from "@excalidraw-agent/shared";
import { startAgentRun } from "../api";
import { useExcalidrawCollab } from "../collab/useExcalidrawCollab";
import type { AgentFooterState } from "@excalidraw-agent/y-excalidraw-browser";

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
  const [selectedModel, setSelectedModel] = useState(() => {
    return window.localStorage.getItem(agentModelStorageKey) ?? defaultAgentModelLabel;
  });
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const {
    agentFooterState,
    binding,
    isAgentInstructionMode,
    onChange,
    onPointerUp,
    setApi,
    status,
    toggleAgentInstructionMode,
  } = useExcalidrawCollab({
    fileId: id ?? "",
    excalidrawElement: shellRef.current,
  });

  if (!id) {
    return <main className="state-page">Missing file id</main>;
  }

  return (
    <main className="canvas-page">
      <div ref={shellRef} className="excalidraw-host">
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
              collabStatus={status}
              isStartingRun={isStartingRun}
              isInstructionMode={isAgentInstructionMode}
              runError={runError}
              selectedModel={selectedModel}
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
              onToggleInstructionMode={toggleAgentInstructionMode}
            />
          </Footer>
        </Excalidraw>
      </div>
    </main>
  );
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
  collabStatus,
  isStartingRun,
  isInstructionMode,
  onModelChange,
  onRunAgent,
  onToggleInstructionMode,
  runError,
  selectedModel,
}: {
  agent: AgentFooterState;
  collabStatus: string;
  isStartingRun: boolean;
  isInstructionMode: boolean;
  onModelChange: (model: string) => void;
  onRunAgent: () => void;
  onToggleInstructionMode: () => void;
  runError: string | null;
  selectedModel: string;
}) {
  const label = toAgentFooterLabel(agent);
  const isRunDisabled = isStartingRun || isAgentRunActive(agent);
  const statusTitle = [
    label,
    agent.ghostElementCount > 0 ? `${agent.ghostElementCount} ghost proposal${agent.ghostElementCount === 1 ? "" : "s"}` : "",
    `Collab: ${collabStatus}`,
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
        aria-label={isRunDisabled ? "Agent is already running" : "Run Agent"}
        className="agent-footer-tools__button"
        disabled={isRunDisabled}
        title={isRunDisabled ? "Agent is already running" : "Run Agent"}
        type="button"
        onClick={onRunAgent}
      >
        <PlayerPlayIcon />
      </button>
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
