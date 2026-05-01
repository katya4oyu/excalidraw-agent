# Concept

## Purpose

Excalidraw Agent is an experimental workspace where a human and an agent can collaborate on the same Excalidraw canvas.

The canvas is not only a local drawing surface. It is a shared Yjs document that can receive edits from:

- a human using the Excalidraw browser UI;
- an agent working headlessly from a prompt;
- local `.excalidraw` files that carry project metadata.

The long-term goal is to make diagram editing feel like collaborative software development: a human keeps control of the main document, while an agent can draft, verify, propose, and apply diagram changes through a reviewable workflow.

## Product Model

The core product idea is:

```text
Human edits canvas
Agent receives instruction
Agent drafts verified Excalidraw scene
Agent publishes proposal
Human reviews proposal on canvas
Approved proposal becomes normal canvas content
```

The agent should not silently overwrite the drawing. Its work should be visible, attributable, and reversible.

For that reason, agent output is expected to move through proposal states before becoming ordinary Excalidraw content. The current implementation already has the beginnings of this model through agent run metadata, proposal metadata, and ghost elements.

## Human Control

The human is the owner of the document.

Agent behavior should follow these principles:

- The agent can be asked to work from explicit prompts or instruction notes on the canvas.
- The agent should communicate progress through document metadata instead of adding permanent canvas noise.
- The agent should publish proposed visual changes as reviewable canvas elements.
- The agent should avoid replacing the full document without considering concurrent human edits.
- The human should be able to approve, reject, or ignore agent proposals.

## Collaboration Model

The shared document is a Yjs document served through Hocuspocus. Browser clients connect to the document and render it through Excalidraw. Agent workers operate outside the browser and use project-local tools to produce `.excalidraw` scenes.

The current implementation uses Codex SDK because it is the most convenient agent runtime for this repository right now. That is an implementation choice, not the concept boundary. The collaboration model should remain agent-agnostic wherever possible.

The intended collaboration model is closer to a rebase workflow than a full key-level CRDT for every Excalidraw property:

```text
base scene
  -> human edits produce current scene
  -> agent edits produce final scene

agent patch = diff(base scene, final scene)
proposal = rebase agent patch onto current scene
```

This keeps the initial design tractable. The project does not currently aim to merge simultaneous edits to the same Excalidraw element at property level.

## Non-Goals

The project is not trying to:

- replace Excalidraw with a custom drawing engine;
- build a complete CRDT model for every Excalidraw element property;
- let agents directly mutate browser-only Excalidraw UI state;
- make unreviewed agent output indistinguishable from human edits;
- solve visual quality of generated diagrams only through sync infrastructure.

## Current State

The repository currently has the main pieces of the intended system:

- a React/Vite web app using Excalidraw;
- a Hono server with Hocuspocus collaboration;
- SQLite persistence for Yjs document updates;
- a worker that prepares per-file agent workspaces and currently starts Codex SDK runs;
- shared helpers for file IDs, document names, Excalidraw metadata, and instruction notes;
- early core/browser/agent packages for Yjs-backed Excalidraw integration;
- design notes for package architecture, vendor decisions, and agent rebase apply.

The implementation is still early. Some architectural documents describe the desired target, while code paths such as verified scene loading, rebased patch creation, approval, rejection, and final proposal promotion are not yet complete.

## Design Direction

The repository should converge on a small number of explicit architectural rules:

- Yjs document schema is shared and documented.
- Browser binding owns Excalidraw UI integration.
- Agent code owns headless scene validation and proposal publication.
- Core code owns schema-level Yjs scene operations.
- Server code owns transport, persistence, and worker supervision.
- Human review remains part of the agent apply path.

These rules are expanded in [Architecture](./architecture.md).
