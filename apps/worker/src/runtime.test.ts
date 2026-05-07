import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeCodexRuntime } from "./runtime.ts";
import type { CodexRuntimeEvent } from "./runtime.ts";

test("fake runtime emits progress and final response events", async () => {
  const runtime = createFakeCodexRuntime([
    {
      events: [{ type: "progress", message: "snapshot loaded" }],
      finalResponse: "done",
    },
  ]);
  const events: CodexRuntimeEvent[] = [];

  const result = await runtime.run({
    prompt: "draw a flow",
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.finalResponse, "done");
  assert.deepEqual(events.map((event) => event.type), ["runStarted", "progress", "finalResponse"]);
  assert.deepEqual(events[1], { type: "progress", message: "snapshot loaded" });
  assert.deepEqual(events[2], { type: "finalResponse", finalResponse: "done" });
});

test("fake runtime emits an error event before throwing", async () => {
  const runtime = createFakeCodexRuntime([{ error: "runtime unavailable" }]);
  const events: CodexRuntimeEvent[] = [];

  await assert.rejects(
    runtime.run({
      prompt: "draw a flow",
      onEvent: (event) => {
        events.push(event);
      },
    }),
    /runtime unavailable/,
  );

  assert.deepEqual(events.map((event) => event.type), ["runStarted", "error"]);
  assert.deepEqual(events[1], { type: "error", error: "runtime unavailable" });
});
