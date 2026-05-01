import { Codex } from "@openai/codex-sdk";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentRunQueueRequest,
  AgentWorkerOptions,
  AgentWorkerRequestMessage,
  AgentWorkerResponseMessage,
} from "@excalidraw-agent/shared";

const defaultAgentModel = "gpt-5.3-codex-spark";

const options = parseArgs(process.argv.slice(2));
if (options.daemon) {
  await runDaemon(options);
} else {
  await runOnce(options);
}

async function runOnce(options: AgentWorkerOptions): Promise<void> {
  const workspace = prepareWorkspace(options);

  if (process.env.EXCALIDRAW_AGENT_PREPARE_ONLY === "true") {
    console.log(workspace);
    return;
  }

  const codex = createCodex(options);
  const thread = codex.startThread({
    model: defaultAgentModel,
    workingDirectory: workspace,
    skipGitRepoCheck: true,
  });

  const result = await thread.run(buildPrompt(options, options.prompt));
  console.log(result.finalResponse);
}

async function runDaemon(options: AgentWorkerOptions): Promise<void> {
  const workspace = prepareWorkspace(options);
  let running = false;
  const queue: AgentRunQueueRequest[] = [];
  const codex = process.env.EXCALIDRAW_AGENT_PREPARE_ONLY === "true" ? null : createCodex(options);
  const thread = codex?.startThread({
    model: defaultAgentModel,
    workingDirectory: workspace,
    skipGitRepoCheck: true,
  });

  sendToParent({ type: "ready", fileId: options.fileId });

  process.on("message", (message: AgentWorkerRequestMessage) => {
    if (message.type === "shutdown") {
      process.exit(0);
    }

    if (message.type === "runQueued" && message.fileId === options.fileId) {
      queue.push(message.request);
      void drain();
    }
  });

  async function drain(): Promise<void> {
    if (running) {
      return;
    }

    const request = queue.shift();
    if (!request) {
      return;
    }

    running = true;
    sendToParent({ type: "runStarted", fileId: options.fileId, runId: request.runId });

    try {
      if (thread) {
        const result = await thread.run(buildPrompt(options, request.prompt, request));
        if (result.finalResponse) {
          console.log(result.finalResponse);
        }
      }
      sendToParent({ type: "runFinished", fileId: options.fileId, runId: request.runId, status: "proposed" });
    } catch (error) {
      sendToParent({
        type: "workerFailed",
        fileId: options.fileId,
        runId: request.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
      void drain();
    }
  }
}

function createCodex(options: AgentWorkerOptions): Codex {
  return new Codex({
    env: {
      ...process.env,
      EXPRESS_SERVER_URL: options.serverUrl,
    },
  });
}

function parseArgs(args: string[]): AgentWorkerOptions {
  const fileId = readFlag(args, "--file-id");
  const serverUrl = readFlag(args, "--server-url") ?? "http://127.0.0.1:8787";
  const workspaceRoot = readFlag(args, "--workspace-root") ?? join(homedir(), ".excalidraw-agent");
  const workspaceTemplate =
    readFlag(args, "--workspace-template") ?? new URL("../templates/codex/", import.meta.url).pathname;
  const prompt = readFlag(args, "--prompt");
  const daemon = args.includes("--daemon");

  if (!fileId) {
    throw new Error("--file-id is required");
  }

  return { daemon, fileId, serverUrl, workspaceRoot, workspaceTemplate, prompt };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function buildPrompt(
  options: AgentWorkerOptions,
  prompt = options.prompt,
  request?: AgentRunQueueRequest,
): string {
  return [
    `対象ファイルID: ${options.fileId}`,
    request ? `Agent run ID: ${request.runId}` : "",
    request ? `Instruction request ID: ${request.requestId}` : "",
    "",
    "この作業スペースの AGENTS.md を読み、Excalidraw作業では .agents/skills/excalidraw-skill/SKILL.md を使ってください。",
    "MCP tools が使えない場合は、skill の REST API mode または付属 scripts を使ってください。",
    ".excalidraw ファイルはこの作業スペース内に作成してください。",
    "",
    prompt ?? "現在はセットアップ確認として、利用できる作業手順を短く確認してください。",
  ].filter((line, index) => line || index > 2).join("\n");
}

function prepareWorkspace(options: AgentWorkerOptions): string {
  const workspace = join(options.workspaceRoot, options.fileId);
  const templateAgents = join(options.workspaceTemplate, "AGENTS.md");
  const templateSkill = join(options.workspaceTemplate, ".agents", "skills", "excalidraw-skill");
  const workspaceAgents = join(workspace, "AGENTS.md");
  const workspaceSkill = join(workspace, ".agents", "skills", "excalidraw-skill");

  mkdirSync(dirname(workspaceSkill), { recursive: true });
  cpSync(templateAgents, workspaceAgents);

  rmSync(workspaceSkill, { recursive: true, force: true });
  try {
    symlinkSync(templateSkill, workspaceSkill, "dir");
  } catch {
    cpSync(templateSkill, workspaceSkill, { recursive: true });
  }

  if (!existsSync(workspaceAgents) || !existsSync(join(workspaceSkill, "SKILL.md"))) {
    throw new Error(`Failed to prepare Codex workspace at ${workspace}`);
  }

  return workspace;
}

function sendToParent(message: AgentWorkerResponseMessage): void {
  if (process.send) {
    process.send(message);
  }
}
