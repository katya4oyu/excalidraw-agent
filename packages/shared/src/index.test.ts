import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentInstructionPlaceholderText,
  createAgentInstructionElement,
  createAgentInstructionNoteElements,
  createExcalidrawAgentMetadata,
  fileIdFromDocumentName,
  getAgentInstructionPrompt,
  getExcalidrawAgentMetadata,
  isAgentInstructionElement,
  toDocumentName,
  withExcalidrawAgentMetadata,
} from "./index.ts";

describe("document names", () => {
  test("converts file ids to hocuspocus document names", () => {
    assert.equal(toDocumentName("abc"), "file:abc");
    assert.equal(fileIdFromDocumentName("file:abc"), "abc");
  });

  test("rejects empty file ids", () => {
    assert.throws(() => toDocumentName(""), /fileId is required/);
  });

  test("embeds and reads Excalidraw Agent metadata", () => {
    const metadata = createExcalidrawAgentMetadata("abc", {
      serverBaseUrl: "http://127.0.0.1:8787",
      updatedAt: "2026-04-30T00:00:00.000Z",
    });
    const document = withExcalidrawAgentMetadata({ type: "excalidraw" }, metadata);

    assert.deepEqual(getExcalidrawAgentMetadata(document), metadata);
    assert.deepEqual(getExcalidrawAgentMetadata(metadata), metadata);
    assert.equal(getExcalidrawAgentMetadata({ excalidrawAgent: { fileId: "abc" } }), null);
  });
});

describe("agent instruction elements", () => {
  test("creates text elements marked for agent instructions", () => {
    const element = createAgentInstructionElement({
      x: 10,
      y: 20,
      text: "Refactor this flow",
    });

    assert.equal(element.type, "text");
    assert.match(element.id as string, /^agent-instruction-/);
    assert.equal(element.x, 10);
    assert.equal(element.y, 20);
    assert.equal(element.text, "Refactor this flow");
    assert.equal(element.originalText, "Refactor this flow");
    assert.deepEqual(element.customData, {
      excalidrawAgent: {
        schemaVersion: 1,
        kind: "instruction",
      },
    });
    assert.equal(isAgentInstructionElement(element), true);
  });

  test("does not infer instructions from ordinary text", () => {
    assert.equal(
      isAgentInstructionElement({
        type: "text",
        text: "agent, please update this",
      }),
      false,
    );
    assert.equal(
      isAgentInstructionElement({
        type: "text",
        customData: {
          excalidrawAgent: {
            schemaVersion: 1,
            kind: "note",
          },
        },
      }),
      false,
    );
  });

  test("creates grouped sticky-note elements for agent instructions", () => {
    const [note, text] = createAgentInstructionNoteElements({
      height: 160,
      x: 10,
      y: 20,
      text: "Check this area",
      width: 300,
    });

    assert.equal(note.type, "rectangle");
    assert.equal(note.width, 300);
    assert.equal(note.height, 160);
    assert.equal(note.backgroundColor, "#fff3bf");
    assert.equal(text.type, "text");
    assert.equal(text.width, 268);
    assert.equal(text.height, 128);
    assert.equal(text.text, "Check this area");
    assert.deepEqual(note.groupIds, text.groupIds);
    assert.equal(isAgentInstructionElement(note), true);
    assert.equal(isAgentInstructionElement(text), true);
  });

  test("extracts prompts only from edited instruction text", () => {
    const [, placeholderText] = createAgentInstructionNoteElements({
      x: 10,
      y: 20,
      text: agentInstructionPlaceholderText,
    });
    const [, editedText] = createAgentInstructionNoteElements({
      x: 10,
      y: 20,
      text: "この付箋の内容で図を整理して",
    });

    assert.equal(getAgentInstructionPrompt(placeholderText), null);
    assert.equal(getAgentInstructionPrompt(editedText), "この付箋の内容で図を整理して");
    assert.equal(getAgentInstructionPrompt({ type: "text", text: "ordinary" }), null);
  });
});
