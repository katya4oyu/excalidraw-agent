import { useRef } from "react";
import { useParams } from "react-router";
import { Excalidraw, Footer, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { getNoteEmbedMetadata } from "@excalidraw-agent/shared";
import { useExcalidrawCollab } from "../collab/useExcalidrawCollab";
import type { AgentFooterState } from "@excalidraw-agent/y-excalidraw-browser";

export function FilePage() {
  const { id } = useParams();
  const shellRef = useRef<HTMLDivElement | null>(null);
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
            <AgentFooterStatus
              agent={agentFooterState}
              collabStatus={status}
              isInstructionMode={isAgentInstructionMode}
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
  event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent<HTMLCanvasElement> }>,
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

function AgentFooterStatus({
  agent,
  collabStatus,
  isInstructionMode,
  onToggleInstructionMode,
}: {
  agent: AgentFooterState;
  collabStatus: string;
  isInstructionMode: boolean;
  onToggleInstructionMode: () => void;
}) {
  const label = toAgentFooterLabel(agent);

  return (
    <div className="agent-footer-status" aria-label={`Agent status: ${label}`}>
      <span className={`agent-footer-status__dot agent-footer-status__dot--${agent.runStatus}`} />
      <span className="agent-footer-status__label">{label}</span>
      {agent.ghostElementCount > 0 ? (
        <span className="agent-footer-status__meta">{agent.ghostElementCount} ghost</span>
      ) : null}
      <span className="agent-footer-status__meta">{collabStatus}</span>
      <button
        aria-label={isInstructionMode ? "Cancel note placement" : "Place note"}
        aria-pressed={isInstructionMode}
        className="agent-footer-status__button"
        title={isInstructionMode ? "Cancel note placement" : "Place note"}
        type="button"
        onClick={onToggleInstructionMode}
      >
        <span className="agent-footer-status__note-icon" aria-hidden="true" />
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
