import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import {
  createAgentInstructionNoteElements,
  createNoteEmbedElement,
  createExcalidrawYMap,
  toDocumentName,
  type FileId,
} from "@excalidraw-agent/shared";
import { createCollabServer, startAgentFromInstructionRequests } from "./collab.ts";

describe("agent instruction request trigger", () => {
  test("does not start an agent from instruction text alone", () => {
    const ydoc = createInstructionDocument("この範囲を整理して");
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.deepEqual(agents.enqueues, []);
    assert.deepEqual(agents.ensureWorkerCalls, ["file-1"]);
    assert.deepEqual(ydoc.getMap("agentRuns").toJSON(), {});
  });

  test("starts an agent only from a queued request matching the current text", () => {
    const ydoc = createInstructionDocument("この範囲を整理して");
    const textId = getTextInstructionId(ydoc);
    ydoc.getMap("agentInstructionRequests").set(textId, {
      status: "queued",
      source: "instruction-note",
      prompt: "この範囲を整理して",
      elementId: textId,
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.equal(agents.enqueues.length, 1);
    assert.equal(agents.enqueues[0]?.fileId, "file-1");
    assert.equal(agents.enqueues[0]?.prompt, "この範囲を整理して");
    assert.equal(agents.enqueues[0]?.requestId, textId);
    assert.equal(getRequestStatus(ydoc, textId), "running");
    assert.equal(Object.values(ydoc.getMap("agentRuns").toJSON()).length, 1);
  });

  test("starts an agent from a queued embeddable note request matching the note text", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("notes").set("note-1", {
      schemaVersion: 1,
      fileId: "file-1",
      noteId: "note-1",
      text: "この付箋の内容で図を整理して",
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
    });
    ydoc.getMap("agentInstructionRequests").set("request-1", {
      status: "queued",
      source: "instruction-note",
      prompt: "この付箋の内容で図を整理して",
      sourceNoteId: "note-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    const runs = Object.values(ydoc.getMap<Record<string, unknown>>("agentRuns").toJSON());
    assert.equal(agents.enqueues.length, 1);
    assert.equal(agents.enqueues[0]?.requestId, "request-1");
    assert.equal(getRequestStatus(ydoc, "request-1"), "running");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.sourceNoteId, "note-1");
  });

  test("starts an agent from embeddable note metadata when the notes map is missing", () => {
    const ydoc = new Y.Doc();
    ydoc.getArray<Y.Map<unknown>>("elements").push([
      createExcalidrawYMap(createNoteEmbedElement({
        fileId: "file-1",
        link: "http://127.0.0.1:5173/note?fileId=file-1&noteId=note-1",
        noteId: "note-1",
        text: "customData から復元して実行",
        x: 0,
        y: 0,
      })),
    ]);
    ydoc.getMap("agentInstructionRequests").set("request-1", {
      status: "queued",
      source: "instruction-note",
      prompt: "customData から復元して実行",
      sourceNoteId: "note-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.equal(agents.enqueues.length, 1);
    assert.equal(agents.enqueues[0]?.requestId, "request-1");
    assert.equal(getRequestStatus(ydoc, "request-1"), "running");
  });

  test("starts an agent from a queued api request without note text validation", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("agentInstructionRequests").set("request-1", {
      status: "queued",
      source: "api",
      prompt: "キャンバス全体を確認して",
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    const runs = Object.values(ydoc.getMap<Record<string, unknown>>("agentRuns").toJSON());
    assert.equal(agents.enqueues.length, 1);
    assert.equal(agents.enqueues[0]?.requestId, "request-1");
    assert.equal(getRequestStatus(ydoc, "request-1"), "running");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.source, "api");
  });

  test("marks queued requests stale when the note text changed before the server sees it", () => {
    const ydoc = createInstructionDocument("現在の本文");
    const textId = getTextInstructionId(ydoc);
    ydoc.getMap("agentInstructionRequests").set(textId, {
      status: "queued",
      source: "instruction-note",
      prompt: "古い本文",
      elementId: textId,
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.deepEqual(agents.enqueues, []);
    assert.equal(getRequestStatus(ydoc, textId), "stale");
  });

  test("marks queued embeddable note requests stale when note text changed", () => {
    const ydoc = new Y.Doc();
    ydoc.getMap("notes").set("note-1", {
      schemaVersion: 1,
      fileId: "file-1",
      noteId: "note-1",
      text: "現在の本文",
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
    });
    ydoc.getMap("agentInstructionRequests").set("request-1", {
      status: "queued",
      source: "instruction-note",
      prompt: "古い本文",
      sourceNoteId: "note-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.deepEqual(agents.enqueues, []);
    assert.equal(getRequestStatus(ydoc, "request-1"), "stale");
  });

  test("ensures a worker and starts queued requests when a persisted document is loaded", async () => {
    const documentName = toDocumentName("file-1");
    const persisted = createInstructionDocument("再接続時に実行して");
    const textId = getTextInstructionId(persisted);
    persisted.getMap("agentInstructionRequests").set(textId, {
      status: "queued",
      source: "instruction-note",
      prompt: "再接続時に実行して",
      elementId: textId,
      createdAt: 1,
      updatedAt: 1,
    });
    const db = new FakeDatabase(documentName, Y.encodeStateAsUpdate(persisted));
    const agents = new FakeAgentStarter();
    const collab = createCollabServer(db, agents);

    const loaded = await collab.configuration.onLoadDocument?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onLoadDocument>>[0]);

    assert.deepEqual(agents.ensureWorkerCalls, ["file-1"]);
    assert.equal(agents.enqueues.length, 1);
    assert.equal(agents.enqueues[0]?.fileId, "file-1");
    assert.equal(agents.enqueues[0]?.prompt, "再接続時に実行して");
    assert.ok(loaded instanceof Y.Doc);
    assert.equal(getRequestStatus(loaded, textId), "running");
  });

  test("reconnecting the same document reuses the existing worker", async () => {
    const documentName = toDocumentName("file-1");
    const db = new FakeDatabase(documentName, null);
    const agents = new FakeAgentStarter();
    const collab = createCollabServer(db, agents);

    await collab.configuration.onLoadDocument?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onLoadDocument>>[0]);
    await collab.configuration.onLoadDocument?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onLoadDocument>>[0]);

    assert.deepEqual(agents.ensureWorkerCalls, ["file-1", "file-1"]);
    assert.equal(agents.workerCreateCount, 1);
    assert.deepEqual(agents.enqueues, []);
  });

  test("keeps a worker while websocket connections are open and schedules stop after the last close", async () => {
    const documentName = toDocumentName("file-1");
    const db = new FakeDatabase(documentName, null);
    const agents = new FakeAgentStarter();
    const collab = createCollabServer(db, agents);

    await collab.configuration.connected?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.connected>>[0]);
    await collab.configuration.connected?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.connected>>[0]);
    await collab.configuration.onDisconnect?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onDisconnect>>[0]);

    assert.deepEqual(agents.ensureWorkerCalls, ["file-1", "file-1"]);
    assert.deepEqual(agents.scheduledStops, []);

    await collab.configuration.onDisconnect?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onDisconnect>>[0]);

    assert.deepEqual(agents.scheduledStops, ["file-1"]);
  });

  test("cancels a scheduled idle stop when the document reconnects during the grace period", async () => {
    const documentName = toDocumentName("file-1");
    const db = new FakeDatabase(documentName, null);
    const agents = new FakeAgentStarter();
    const collab = createCollabServer(db, agents);

    await collab.configuration.connected?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.connected>>[0]);
    await collab.configuration.onDisconnect?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.onDisconnect>>[0]);
    await collab.configuration.connected?.({
      documentName,
    } as Parameters<NonNullable<typeof collab.configuration.connected>>[0]);

    assert.deepEqual(agents.scheduledStops, ["file-1"]);
    assert.deepEqual(agents.cancelledStops, ["file-1", "file-1"]);
    assert.deepEqual(agents.ensureWorkerCalls, ["file-1", "file-1"]);
  });

  test("leaves a second queued request untouched while a run is active", () => {
    const ydoc = createInstructionDocument("最初の指示");
    const firstTextId = getTextInstructionId(ydoc);
    const secondText = createAgentInstructionNoteElements({
      x: 10,
      y: 180,
      text: "次の指示",
    });
    const secondTextId = String(secondText.find((element) => element.type === "text")?.id);
    ydoc
      .getArray<Y.Map<unknown>>("elements")
      .push(secondText.map((element) => createExcalidrawYMap(element)));
    ydoc.getMap("agentInstructionRequests").set(firstTextId, {
      status: "queued",
      source: "instruction-note",
      prompt: "最初の指示",
      elementId: firstTextId,
      createdAt: 1,
      updatedAt: 1,
    });
    ydoc.getMap("agentInstructionRequests").set(secondTextId, {
      status: "queued",
      source: "instruction-note",
      prompt: "次の指示",
      elementId: secondTextId,
      createdAt: 2,
      updatedAt: 2,
    });
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);
    agents.active = true;
    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.equal(getRequestStatus(ydoc, firstTextId), "running");
    assert.equal(getRequestStatus(ydoc, secondTextId), "queued");
    assert.equal(agents.enqueues.length, 1);
  });
});

class FakeAgentStarter {
  readonly enqueues: Array<{ fileId: FileId; prompt: string; requestId: string; runId: string }> = [];
  readonly ensureWorkerCalls: FileId[] = [];
  readonly scheduledStops: FileId[] = [];
  readonly cancelledStops: FileId[] = [];
  active = false;
  private readonly workers = new Set<FileId>();

  get workerCreateCount(): number {
    return this.workers.size;
  }

  ensureWorker(fileId: FileId): unknown {
    this.ensureWorkerCalls.push(fileId);
    this.workers.add(fileId);
    return {};
  }

  isRunActive(): boolean {
    return this.active;
  }

  enqueueRun(fileId: FileId, request: { prompt: string; requestId: string; runId: string }): boolean {
    this.enqueues.push({ fileId, prompt: request.prompt, requestId: request.requestId, runId: request.runId });
    this.active = true;
    return true;
  }

  markFromDocumentName(): void {}

  scheduleIdleWorkerStop(fileId: FileId): void {
    this.scheduledStops.push(fileId);
  }

  cancelIdleWorkerStop(fileId: FileId): void {
    this.cancelledStops.push(fileId);
  }
}

class FakeDatabase {
  private readonly documentName: string;
  private readonly state: Uint8Array | null;

  constructor(documentName: string, state: Uint8Array | null) {
    this.documentName = documentName;
    this.state = state;
  }

  loadDocument(documentName: ReturnType<typeof toDocumentName>): Uint8Array | null {
    return documentName === this.documentName ? this.state : null;
  }

  storeDocument(): void {}
}

function createInstructionDocument(text: string): Y.Doc {
  const ydoc = new Y.Doc();
  const elements = createAgentInstructionNoteElements({
    x: 10,
    y: 20,
    text,
  });
  ydoc.getArray<Y.Map<unknown>>("elements").push(elements.map((element) => createExcalidrawYMap(element)));
  return ydoc;
}

function getTextInstructionId(ydoc: Y.Doc): string {
  const textElement = ydoc
    .getArray<Y.Map<unknown>>("elements")
    .toArray()
    .map((item) => item.get("el"))
    .find((element) => isRecord(element) && element.type === "text");

  assert.ok(isRecord(textElement));
  assert.equal(typeof textElement.id, "string");
  return textElement.id as string;
}

function getRequestStatus(ydoc: Y.Doc, requestId: string): unknown {
  const request = ydoc.getMap("agentInstructionRequests").get(requestId);
  return isRecord(request) ? request.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
