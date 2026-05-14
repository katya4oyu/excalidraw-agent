import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getCodexStatus, type CodexStatusCommandResult } from "./codexStatus.ts";

describe("getCodexStatus", () => {
  test("reports command missing as an error", async () => {
    const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });

    assert.deepEqual(await getCodexStatus(async () => {
      throw error;
    }), {
      status: "error",
      authMethod: null,
      message: "codex command was not found.",
    });
  });

  test("reports a not logged in status from output", async () => {
    assert.deepEqual(await getCodexStatus(result({
      exitCode: 1,
      stderr: "Not logged in. Please log in with codex login.",
    })), {
      status: "not_logged_in",
      authMethod: "unknown",
      message: "Not logged in. Please log in with codex login.",
    });
  });

  test("detects ChatGPT auth output", async () => {
    assert.deepEqual(await getCodexStatus(result({
      stdout: "Logged in with ChatGPT",
    })), {
      status: "available",
      authMethod: "chatgpt",
      message: "Logged in with ChatGPT",
    });
  });

  test("detects API key auth output", async () => {
    assert.deepEqual(await getCodexStatus(result({
      stdout: "Authenticated via API key",
    })), {
      status: "available",
      authMethod: "api_key",
      message: "Authenticated via API key",
    });
  });

  test("detects access token auth output", async () => {
    assert.deepEqual(await getCodexStatus(result({
      stdout: "Using access token from local credentials",
    })), {
      status: "available",
      authMethod: "access_token",
      message: "Using access token from local credentials",
    });
  });

  test("reports a non-zero exit as an error when it is not a login failure", async () => {
    assert.deepEqual(await getCodexStatus(result({
      exitCode: 2,
      stderr: "unexpected codex failure",
    })), {
      status: "error",
      authMethod: "unknown",
      message: "unexpected codex failure",
    });
  });
});

function result(overrides: Partial<CodexStatusCommandResult>) {
  return async (): Promise<CodexStatusCommandResult> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  });
}
