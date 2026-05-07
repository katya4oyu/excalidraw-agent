import { Codex } from "@openai/codex-sdk";
import type { Thread, ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

export type CodexRuntimeEvent =
  | { type: "runStarted"; threadId: string | null }
  | { type: "progress"; message: string; sourceEvent?: ThreadEvent }
  | { type: "finalResponse"; finalResponse: string }
  | { type: "error"; error: string; sourceEvent?: ThreadEvent };

export type CodexRuntimeRunInput = {
  prompt: string;
  onEvent?: (event: CodexRuntimeEvent) => void;
};

export type CodexRuntimeRunResult = {
  finalResponse: string;
  items: ThreadItem[];
  usage: Usage | null;
};

export interface CodexRuntime {
  run(input: CodexRuntimeRunInput): Promise<CodexRuntimeRunResult>;
}

export type TypeScriptSdkCodexRuntimeOptions = {
  env: Record<string, string>;
  model: string;
  skipGitRepoCheck: boolean;
  workingDirectory: string;
};

export function createTypeScriptSdkCodexRuntime(options: TypeScriptSdkCodexRuntimeOptions): CodexRuntime {
  const codex = new Codex({
    env: options.env,
  });
  const thread = codex.startThread({
    model: options.model,
    workingDirectory: options.workingDirectory,
    skipGitRepoCheck: options.skipGitRepoCheck,
  });
  return new TypeScriptSdkCodexRuntime(thread);
}

class TypeScriptSdkCodexRuntime implements CodexRuntime {
  private readonly thread: Thread;

  constructor(thread: Thread) {
    this.thread = thread;
  }

  async run(input: CodexRuntimeRunInput): Promise<CodexRuntimeRunResult> {
    input.onEvent?.({ type: "runStarted", threadId: this.thread.id });

    const { events } = await this.thread.runStreamed(input.prompt);
    const items: ThreadItem[] = [];
    let finalResponse = "";
    let usage: Usage | null = null;

    for await (const event of events) {
      if (event.type === "thread.started") {
        input.onEvent?.({ type: "runStarted", threadId: event.thread_id });
        continue;
      }

      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        input.onEvent?.({
          type: "progress",
          message: describeThreadItem(event.item),
          sourceEvent: event,
        });
        if (event.type === "item.completed") {
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
            input.onEvent?.({ type: "finalResponse", finalResponse });
          }
          items.push(event.item);
        }
        continue;
      }

      if (event.type === "turn.completed") {
        usage = event.usage;
        input.onEvent?.({ type: "progress", message: "Codex turn completed", sourceEvent: event });
        continue;
      }

      if (event.type === "turn.failed") {
        input.onEvent?.({ type: "error", error: event.error.message, sourceEvent: event });
        throw new Error(event.error.message);
      }

      if (event.type === "error") {
        input.onEvent?.({ type: "error", error: event.message, sourceEvent: event });
        throw new Error(event.message);
      }

      input.onEvent?.({ type: "progress", message: event.type, sourceEvent: event });
    }

    return { finalResponse, items, usage };
  }
}

export type FakeCodexRuntimeTurn = {
  events?: CodexRuntimeEvent[];
  finalResponse?: string;
  error?: string;
};

export function createFakeCodexRuntime(turns: FakeCodexRuntimeTurn[]): CodexRuntime {
  const pending = [...turns];
  return {
    async run(input) {
      const turn = pending.shift() ?? {};
      input.onEvent?.({ type: "runStarted", threadId: "fake-thread" });
      for (const event of turn.events ?? []) {
        input.onEvent?.(event);
      }
      if (turn.error) {
        input.onEvent?.({ type: "error", error: turn.error });
        throw new Error(turn.error);
      }
      const finalResponse = turn.finalResponse ?? "";
      input.onEvent?.({ type: "finalResponse", finalResponse });
      return { finalResponse, items: [], usage: null };
    },
  };
}

function describeThreadItem(item: ThreadItem): string {
  switch (item.type) {
    case "agent_message":
      return item.text ? `Codex response: ${truncateForLog(item.text)}` : "Codex response";
    case "reasoning":
      return item.text ? `Codex reasoning: ${truncateForLog(item.text)}` : "Codex reasoning";
    case "command_execution":
      return `Codex command ${item.status}: ${item.command}`;
    case "file_change":
      return `Codex file change ${item.status}: ${item.changes.map((change) => change.path).join(", ")}`;
    case "mcp_tool_call":
      return `Codex MCP ${item.status}: ${item.server}.${item.tool}`;
    case "web_search":
      return `Codex web search: ${item.query}`;
    case "todo_list":
      return `Codex todo list: ${item.items.filter((todo) => todo.completed).length}/${item.items.length} completed`;
    case "error":
      return `Codex error: ${item.message}`;
  }
}

function truncateForLog(value: string): string {
  return value.length > 160 ? `${value.slice(0, 159)}...` : value;
}
