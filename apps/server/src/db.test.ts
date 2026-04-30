import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as Y from "yjs";
import { toDocumentName } from "@excalidraw-agent/shared";
import { AppDatabase } from "./db.ts";

describe("AppDatabase", () => {
  test("stores metadata and yjs document state", () => {
    const db = new AppDatabase(":memory:");
    const documentName = toDocumentName("test-file");

    db.createFile("test-file", documentName);
    assert.equal(db.getFile("test-file")?.documentName, documentName);

    const ydoc = new Y.Doc();
    ydoc.getMap("meta").set("hello", "world");
    db.storeDocument(documentName, Y.encodeStateAsUpdate(ydoc));

    const restored = new Y.Doc();
    const state = db.loadDocument(documentName);
    assert.notEqual(state, null);
    Y.applyUpdate(restored, state!);
    assert.equal(restored.getMap("meta").get("hello"), "world");
    db.close();
  });
});
