import { useRef } from "react";
import { useParams } from "react-router";
import { Excalidraw, Footer, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useExcalidrawCollab } from "../collab/useExcalidrawCollab";
import type { AgentFooterState } from "@excalidraw-agent/y-excalidraw-browser";

export function FilePage() {
  const { id } = useParams();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const { addAgentInstruction, agentFooterState, binding, setApi, status } = useExcalidrawCollab({
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
          onPointerUpdate={binding?.onPointerUpdate}
        >
          <WelcomeScreen />
          <Footer>
            <AgentFooterStatus
              agent={agentFooterState}
              collabStatus={status}
              onAddInstruction={addAgentInstruction}
            />
          </Footer>
        </Excalidraw>
      </div>
    </main>
  );
}

function AgentFooterStatus({
  agent,
  collabStatus,
  onAddInstruction,
}: {
  agent: AgentFooterState;
  collabStatus: string;
  onAddInstruction: () => void;
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
      <button className="agent-footer-status__button" type="button" onClick={onAddInstruction}>
        Note
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
