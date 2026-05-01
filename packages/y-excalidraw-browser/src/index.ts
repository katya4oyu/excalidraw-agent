import {
  approveAgentProposal,
  readAgentFooterState,
  rejectAgentProposal,
  type AgentFooterState,
} from "@excalidraw-agent/y-excalidraw-core";
import { ExcalidrawBinding } from "@mizuka-wu/y-excalidraw";
import type * as Y from "yjs";

export { ExcalidrawBinding };
export type { AgentFooterState } from "@excalidraw-agent/y-excalidraw-core";
export { approveAgentProposal, rejectAgentProposal };

export interface AgentFooterStateObserverStores {
  elements: Y.Array<Y.Map<unknown>>;
  agentRuns: Y.Map<unknown>;
  agentProposals: Y.Map<unknown>;
}

export const createAgentFooterStateObserver = (
  stores: AgentFooterStateObserverStores,
  onChange: (state: AgentFooterState) => void,
): (() => void) => {
  const emit = () => {
    onChange(readAgentFooterState(stores));
  };

  emit();
  stores.elements.observe(emit);
  stores.agentRuns.observe(emit);
  stores.agentProposals.observe(emit);

  return () => {
    stores.elements.unobserve(emit);
    stores.agentRuns.unobserve(emit);
    stores.agentProposals.unobserve(emit);
  };
};
