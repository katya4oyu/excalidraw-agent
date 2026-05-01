# Architecture

## Overview

Excalidraw Agent is a pnpm workspace organized around a shared Yjs document.

```text
apps/
  web       Browser UI for human editing and proposal review
  server    REST API, Hocuspocus WebSocket server, persistence, worker supervisor
  worker    Agent runtime runner for per-file workspaces

packages/
  shared                 Common IDs, metadata, and Excalidraw helper utilities
  y-excalidraw-core      Shared Yjs schema and scene operations
  y-excalidraw-browser   Browser binding and browser-facing observers
  y-excalidraw-agent     Headless agent proposal helpers
```

The intended dependency direction is:

```text
web -> shared, y-excalidraw-browser
server -> shared
worker -> shared
y-excalidraw-browser -> y-excalidraw-core
y-excalidraw-agent -> y-excalidraw-core
y-excalidraw-core -> yjs
```

`y-excalidraw-core` should not depend on React, DOM APIs, browser awareness, filesystem APIs, the server, or any specific agent runtime SDK.

## Runtime Flow

### Create File

```text
POST /api/files
  -> server creates fileId and documentName
  -> server stores file metadata in SQLite
  -> server starts worker for the file
  -> web opens /files/:fileId
```

Document names use the `file:{fileId}` format.

### Browser Collaboration

```text
Browser Excalidraw UI
  -> y-excalidraw-browser binding
  -> Y.Doc elements/assets/appState
  -> Hocuspocus provider
  -> server /collab
  -> SQLite persisted Yjs update
```

The browser is responsible for:

- converting human Excalidraw edits into Yjs updates;
- applying remote Yjs updates back to Excalidraw;
- sending pointer/collaborator awareness;
- showing agent run/proposal state in the UI;
- creating instruction notes that request agent work.

### Agent Instruction Notes

Instruction notes are Excalidraw elements with project metadata in `customData.excalidrawAgent`.

The browser watches edited elements. When an instruction note contains a prompt, it writes a queued request into the Yjs `agentInstructionRequests` map.

The server watches loaded documents and starts a worker when it finds a queued request whose prompt still matches the instruction element.

### Worker Execution

The worker prepares an agent workspace under:

```text
~/.excalidraw-agent/{fileId}/
```

It copies `AGENTS.md`, links or copies the Excalidraw skill, then starts the configured agent runtime with:

- the target file ID;
- the server URL;
- the user prompt, if provided;
- a working directory scoped to the file.

The intended worker responsibility is to produce and verify `.excalidraw` scene files before publishing a proposal back to Yjs.

The current implementation uses Codex SDK as that runtime. This is a concrete implementation choice, not an architectural requirement that the collaborator must always be Codex.

## Yjs Document Schema

The shared document currently uses these top-level structures:

```text
Y.Doc
  elements: Y.Array<Y.Map>
  assets: Y.Map
  appState: Y.Map
  agentRuns: Y.Map
  agentProposals: Y.Map
  agentInstructionRequests: Y.Map
```

### elements

`elements` stores Excalidraw elements as Yjs map entries:

```text
Y.Map
  el: Excalidraw element object
  pos: ordering key
```

The intended ordering rule is that display order is derived from `pos`, not from the physical Y.Array index. Move operations should update `pos` instead of reshuffling the array.

### assets

`assets` stores Excalidraw binary file data keyed by file ID when assets are managed inside the Yjs document.

The architecture should still allow external asset management later.

### appState

`appState` stores imported Excalidraw app state when available. Browser clients may apply it after sync.

### agentInstructionRequests

`agentInstructionRequests` stores queued and running requests created from instruction notes.

Typical fields:

- `status`;
- `source`;
- `prompt`;
- `elementId`;
- `runId`;
- `createdAt`;
- `updatedAt`.

### agentRuns

`agentRuns` stores run-level state for UI feedback and apply lifecycle tracking.

It is metadata, not drawing content.

### agentProposals

`agentProposals` stores proposal-level state such as proposal status, associated run ID, ghost element IDs, and eventually patch metadata.

## Agent Proposal Model

The target model is a reviewable rebase workflow.

```text
1. Read base scene at worker start.
2. Agent creates final verified scene.
3. Read current scene at proposal time.
4. Diff base scene against final scene.
5. Rebase agent changes onto current scene.
6. Publish ghost elements and proposal metadata.
7. Human approves or rejects.
8. Approved proposal is promoted into normal elements.
```

The current implementation only contains early pieces of this flow:

- agent run status metadata;
- proposal status metadata;
- ghost element creation;
- browser footer state observation;
- worker startup and agent runtime execution.

The full rebase, conflict detection, approval, rejection, and promotion path still needs implementation.

## Package Responsibilities

### apps/web

Owns browser UX:

- Excalidraw rendering;
- collaboration provider setup;
- browser binding lifecycle;
- agent status footer;
- instruction note placement;
- save/open/import behavior.

It should not own headless scene diffing or server persistence policy.

### apps/server

Owns backend coordination:

- REST API;
- Hocuspocus WebSocket handling;
- loading and storing Yjs updates;
- creating file metadata;
- importing `.excalidraw` documents;
- supervising workers;
- detecting queued instruction requests.

It should avoid browser-specific Excalidraw behavior.

### apps/worker

Owns agent process startup:

- preparing a file-scoped workspace;
- installing or linking agent instructions and skills;
- starting the configured agent runtime;
- passing the file ID, server URL, and prompt to the agent.

The worker should eventually call package-level agent APIs to publish verified proposals.

### packages/shared

Owns cross-package primitive helpers:

- `FileId`;
- `CollabDocumentName`;
- file metadata;
- Excalidraw Agent metadata embedded in files;
- instruction note element creation;
- small Yjs insertion helpers that are not browser-specific.

As the core package matures, Yjs scene mutation helpers should move out of `shared` if they belong to the canonical scene model.

### packages/y-excalidraw-core

Owns the canonical Yjs-backed Excalidraw scene model:

- schema definitions;
- reading scene state;
- sorting elements by `pos`;
- appending, upserting, deleting, moving, and replacing elements;
- asset read/write helpers;
- validation of malformed Yjs entries;
- transaction origin support.

This package is the boundary that should let browser and agent code share the same scene semantics.

### packages/y-excalidraw-browser

Owns browser binding behavior:

- Excalidraw `onChange` integration;
- remote Yjs update application;
- awareness and collaborator state;
- undo/redo integration;
- guarding against feedback loops from remote updates;
- preserving local pending edits when remote updates arrive;
- observing agent footer state.

The current implementation still relies on `@mizuka-wu/y-excalidraw` for the binding and adds local agent state observation.

### packages/y-excalidraw-agent

Owns headless agent apply/proposal behavior:

- starting agent run metadata;
- validating verified scenes;
- diffing base/final/current scenes;
- creating rebased patches;
- publishing ghost proposals;
- applying approved proposals.

The current implementation only covers start metadata and ghost proposal publication.

## Persistence

SQLite stores file metadata and encoded Yjs document updates. The server persists document state through Hocuspocus store hooks.

Development data is written under `apps/server/data/` and is not committed.

Local `.excalidraw` files may embed `excalidrawAgent` metadata so an imported file can return to the same collaborative document.

## Boundaries and Constraints

- Browser-only APIs stay out of core and agent packages.
- Specific agent runtime SDKs stay in the worker boundary.
- Server persistence does not depend on React or Excalidraw UI internals.
- Agent proposals should not become normal elements until reviewed.
- Full-document replacement is not the default apply strategy for agent output.
- Same-element concurrent property-level merge is outside the initial scope.

## Known Gaps

The architecture currently has several incomplete areas:

- `y-excalidraw-core` does not yet expose the full scene API described by the design notes.
- Agent output is not yet fully loaded, validated, diffed, rebased, and published from worker output.
- Approval/rejection UI and proposal promotion are not complete.
- Conflict detection is documented but not implemented end-to-end.
- Browser binding is still mostly delegated to an external fork instead of being fully project-owned.
- The canonical Yjs schema is still split between this overview and the detailed [y-excalidraw design notes](./y-excalidraw/README.md); it should be consolidated further as implementation catches up.

These gaps are expected at this stage, but they should remain visible so future changes do not mistake target architecture for completed behavior.
