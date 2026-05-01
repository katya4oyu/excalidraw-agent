import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import {
  agentInstructionPlaceholderText,
  createAgentInstructionElement,
  createAgentInstructionNoteElements,
  createExcalidrawAgentMetadata,
  createExcalidrawYMap,
  createNoteEmbedElement,
  createNoteRecord,
  fileIdFromDocumentName,
  getAgentInstructionPrompt,
  getExcalidrawAgentMetadata,
  getNoteEmbedMetadata,
  getNoteText,
  insertExcalidrawElements,
  isAgentInstructionElement,
  normalizeExcalidrawElementPositions,
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
  test("uses valid fractional order keys for Yjs element positions", () => {
    const ydoc = new Y.Doc();

    insertExcalidrawElements(ydoc, [
      { id: "shape-1", type: "rectangle", version: 1 },
      { id: "shape-2", type: "rectangle", version: 1 },
    ]);

    const positions = ydoc.getArray<Y.Map<unknown>>("elements").toArray().map((item) => item.get("pos"));
    assert.deepEqual(positions, ["a0", "a1"]);
  });

  test("normalizes legacy timestamp element positions", () => {
    const ydoc = new Y.Doc();
    ydoc.getArray<Y.Map<unknown>>("elements").push([
      createExcalidrawYMap({ id: "shape-1", type: "rectangle", version: 1 }, "1777627026115:id-1"),
      createExcalidrawYMap({ id: "shape-2", type: "rectangle", version: 1 }, "1777627026116:id-2"),
    ]);

    assert.equal(normalizeExcalidrawElementPositions(ydoc), true);
    assert.deepEqual(
      ydoc.getArray<Y.Map<unknown>>("elements").toArray().map((item) => item.get("pos")),
      ["a0", "a1"],
    );
  });

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

  test("creates generic embeddable notes", () => {
    const element = createNoteEmbedElement({
      fileId: "file-1",
      link: "http://127.0.0.1:5173/note?fileId=file-1&noteId=note-1",
      noteId: "note-1",
      x: 10,
      y: 20,
    });

    assert.equal(element.type, "embeddable");
    assert.equal(element.id, "note-1");
    assert.equal(element.width, 420);
    assert.equal(element.height, 220);
    assert.equal(element.link, "http://127.0.0.1:5173/note?fileId=file-1&noteId=note-1");
    assert.deepEqual(getNoteEmbedMetadata(element), {
      schemaVersion: 1,
      kind: "note-embed",
      fileId: "file-1",
      noteId: "note-1",
      text: "",
    });
  });

  test("stores note text in note records and mirrors it into embeddable metadata", () => {
    const note = createNoteRecord("file-1", "note-1", 1);
    const element = createNoteEmbedElement({
      fileId: "file-1",
      link: "http://127.0.0.1:5173/note?fileId=file-1&noteId=note-1",
      noteId: "note-1",
      text: "図を整理して",
      x: 10,
      y: 20,
    });

    assert.deepEqual(note, {
      schemaVersion: 1,
      fileId: "file-1",
      noteId: "note-1",
      text: "",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(getNoteText(note), null);
    assert.equal(getNoteText({ ...note, text: "  図を整理して  " }), "図を整理して");
    assert.equal(getNoteEmbedMetadata(element)?.text, "図を整理して");
  });
});
