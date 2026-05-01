import { Codex } from "@openai/codex-sdk";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import type {
  AgentRunQueueRequest,
  AgentWorkerOptions,
  AgentWorkerRequestMessage,
  AgentWorkerResponseMessage,
} from "@excalidraw-agent/shared";
import { toDocumentName } from "@excalidraw-agent/shared";

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
  const prepareOnly = process.env.EXCALIDRAW_AGENT_PREPARE_ONLY === "true";
  const collab = prepareOnly ? null : await connectFileDocument(options);
  const codex = prepareOnly ? null : createCodex(options);
  const thread = codex?.startThread({
    model: defaultAgentModel,
    workingDirectory: workspace,
    skipGitRepoCheck: true,
  });

  sendToParent({ type: "ready", fileId: options.fileId });

  process.on("message", (message: AgentWorkerRequestMessage) => {
    if (message.type === "shutdown") {
      collab?.provider.destroy();
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
    collab?.document.transact(() => {
      writeRunStatus(collab.document, request.runId, {
        status: "running",
        requestId: request.requestId,
        prompt: request.prompt,
        updatedAt: Date.now(),
      });
    });

    try {
      const snapshotPath = collab ? writeRunSnapshot(workspace, collab.document, request) : undefined;
      if (thread) {
        const result = await thread.run(buildPrompt(options, request.prompt, request, snapshotPath));
        if (result.finalResponse) {
          console.log(result.finalResponse);
        }
      }
      collab?.document.transact(() => {
        writeRunStatus(collab.document, request.runId, {
          status: "proposed",
          requestId: request.requestId,
          prompt: request.prompt,
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
      sendToParent({ type: "runFinished", fileId: options.fileId, runId: request.runId, status: "proposed" });
    } catch (error) {
      collab?.document.transact(() => {
        writeRunStatus(collab.document, request.runId, {
          status: "failed",
          requestId: request.requestId,
          prompt: request.prompt,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        });
      });
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

async function connectFileDocument(options: AgentWorkerOptions): Promise<{
  document: Y.Doc;
  provider: HocuspocusProvider;
}> {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: toCollabWebSocketUrl(options.serverUrl),
    name: toDocumentName(options.fileId),
    document,
  });

  await waitForProviderSync(provider);
  return { document, provider };
}

function waitForProviderSync(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for worker Yjs sync"));
    }, 10_000);
    const handleSynced = () => {
      cleanup();
      resolve();
    };
    const handleClose = ({ event }: { event?: { reason?: string } }) => {
      cleanup();
      reject(new Error(`Worker Yjs connection closed${event?.reason ? `: ${event.reason}` : ""}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      provider.off("synced", handleSynced);
      provider.off("close", handleClose);
    };

    provider.on("synced", handleSynced);
    provider.on("close", handleClose);
  });
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
  snapshotPath?: string,
): string {
  return [
    `対象ファイルID: ${options.fileId}`,
    request ? `Agent run ID: ${request.runId}` : "",
    request ? `Instruction request ID: ${request.requestId}` : "",
    snapshotPath ? `同期済みキャンバス snapshot: ${snapshotPath}` : "",
    "",
    "この作業スペースの AGENTS.md を読み、Excalidraw作業では .agents/skills/excalidraw-skill/SKILL.md を使ってください。",
    "MCP tools が使えない場合は、skill の REST API mode または付属 scripts を使ってください。",
    ".excalidraw ファイルはこの作業スペース内に作成してください。",
    snapshotPath ? "作業開始時には必ず snapshot JSON を読み、現在の canvas 要素・notes・agentRuns を確認してください。" : "",
    "",
    prompt ?? "現在はセットアップ確認として、利用できる作業手順を短く確認してください。",
  ].filter((line, index) => line || index > 2).join("\n");
}

function writeRunSnapshot(workspace: string, document: Y.Doc, request: AgentRunQueueRequest): string {
  const runsDirectory = join(workspace, "runs", request.runId);
  mkdirSync(runsDirectory, { recursive: true });

  const snapshotPath = join(runsDirectory, "base-scene.json");
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      fileId: request.fileId,
      requestId: request.requestId,
      runId: request.runId,
      prompt: request.prompt,
      capturedAt: new Date().toISOString(),
      elements: document.getArray<Y.Map<unknown>>("elements").toArray().map((item) => item.get("el")),
      assets: document.getMap("assets").toJSON(),
      notes: document.getMap("notes").toJSON(),
      agentRuns: document.getMap("agentRuns").toJSON(),
      agentProposals: document.getMap("agentProposals").toJSON(),
    }, null, 2),
  );
  return snapshotPath;
}

function writeRunStatus(document: Y.Doc, runId: string, patch: Record<string, unknown>): void {
  const agentRuns = document.getMap<Record<string, unknown>>("agentRuns");
  const current = agentRuns.get(runId);
  agentRuns.set(runId, {
    ...(isRecord(current) ? current : {}),
    ...patch,
  });
}

function toCollabWebSocketUrl(serverUrl: string): string {
  const url = new URL("/collab", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
