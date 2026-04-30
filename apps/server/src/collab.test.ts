import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import {
  createAgentInstructionNoteElements,
  createExcalidrawYMap,
  type FileId,
} from "@excalidraw-agent/shared";
import { startAgentFromInstructionRequests } from "./collab.ts";

describe("agent instruction request trigger", () => {
  test("does not start an agent from instruction text alone", () => {
    const ydoc = createInstructionDocument("この範囲を整理して");
    const agents = new FakeAgentStarter();

    startAgentFromInstructionRequests(ydoc, "file-1", agents);

    assert.deepEqual(agents.starts, []);
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

    assert.deepEqual(agents.starts, [{ fileId: "file-1", prompt: "この範囲を整理して" }]);
    assert.equal(getRequestStatus(ydoc, textId), "running");
    assert.equal(Object.values(ydoc.getMap("agentRuns").toJSON()).length, 1);
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

    assert.deepEqual(agents.starts, []);
    assert.equal(getRequestStatus(ydoc, textId), "stale");
  });
});

class FakeAgentStarter {
  readonly starts: Array<{ fileId: FileId; prompt: string | undefined }> = [];

  isRunning(): boolean {
    return false;
  }

  start(fileId: FileId, options: { prompt?: string }): boolean {
    this.starts.push({ fileId, prompt: options.prompt });
    return true;
  }
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
