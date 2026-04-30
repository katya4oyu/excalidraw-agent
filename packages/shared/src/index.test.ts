import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileIdFromDocumentName, toDocumentName } from "./index.ts";

describe("document names", () => {
  test("converts file ids to hocuspocus document names", () => {
    assert.equal(toDocumentName("abc"), "file:abc");
    assert.equal(fileIdFromDocumentName("file:abc"), "abc");
  });

  test("rejects empty file ids", () => {
    assert.throws(() => toDocumentName(""), /fileId is required/);
  });
});
