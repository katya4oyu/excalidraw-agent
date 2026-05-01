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
import { getNoteText, toDocumentName } from "@excalidraw-agent/shared";
import { publishGhostProposal } from "@excalidraw-agent/y-excalidraw-agent";

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
    const presence = collab ? startAgentPresence(collab.provider, collab.document, request) : null;
    collab?.document.transact(() => {
      writeRunStatus(collab.document, request.runId, {
        status: "running",
        requestId: request.requestId,
        prompt: request.prompt,
        updatedAt: Date.now(),
      });
    });

    try {
      let codexError: string | undefined;
      presence?.update("キャンバスを同期し、現在の要素とNoteを読み込んでいます");
      const snapshotPath = collab ? writeRunSnapshot(workspace, collab.document, request) : undefined;
      presence?.update("base-scene.json を保存しました");
      if (thread) {
        try {
          presence?.update("Codex thread.run を開始しました");
          const result = await thread.run(buildPrompt(options, request.prompt, request, snapshotPath));
          presence?.update("Codex の応答を受け取りました");
          if (result.finalResponse) {
            console.log(result.finalResponse);
          }
        } catch (error) {
          codexError = error instanceof Error ? error.message : String(error);
          console.error(`Codex run failed; publishing fallback proposal: ${codexError}`);
          presence?.update("Codex が失敗したため、Worker fallback proposal を作成します");
        }
      }
      const proposedElements = collab ? createDemoProposalElements(collab.document, request) : [];
      collab?.document.transact(() => {
        const finishedAt = Date.now();
        if (proposedElements.length > 0) {
          const ghostElementIds = publishGhostProposal(
            {
              elements: collab.document.getArray<Y.Map<unknown>>("elements"),
              agentRuns: collab.document.getMap("agentRuns"),
              agentProposals: collab.document.getMap("agentProposals"),
            },
            {
              runId: request.runId,
              elements: proposedElements,
              operation: "add",
              createdAt: finishedAt,
            },
          );
          writeRunStatus(collab.document, request.runId, {
            requestId: request.requestId,
            prompt: request.prompt,
            ...(codexError ? { codexError } : {}),
            finishedAt,
            updatedAt: finishedAt,
            ghostElementIds,
          });
        } else {
          writeRunStatus(collab.document, request.runId, {
            status: "proposed",
            requestId: request.requestId,
            prompt: request.prompt,
            ...(codexError ? { codexError } : {}),
            finishedAt,
            updatedAt: finishedAt,
          });
        }
        writeRequestStatus(collab.document, request.requestId, {
          status: "proposed",
          runId: request.runId,
          updatedAt: finishedAt,
        });
      });
      presence?.finish("ghost proposal をYjsへ publish しました", "proposed");
      sendToParent({ type: "runFinished", fileId: options.fileId, runId: request.runId, status: "proposed" });
    } catch (error) {
      collab?.document.transact(() => {
        const finishedAt = Date.now();
        writeRunStatus(collab.document, request.runId, {
          status: "failed",
          requestId: request.requestId,
          prompt: request.prompt,
          error: error instanceof Error ? error.message : String(error),
          finishedAt,
          updatedAt: finishedAt,
        });
        writeRequestStatus(collab.document, request.requestId, {
          status: "failed",
          runId: request.runId,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: finishedAt,
        });
      });
      presence?.finish(error instanceof Error ? error.message : String(error), "failed");
      sendToParent({
        type: "workerFailed",
        fileId: options.fileId,
        runId: request.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      presence?.stop();
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
  provider.awareness?.setLocalStateField("user", {
    name: "Agent",
    color: "#6965db",
    colorLight: "#e0dfff",
    role: "agent",
    state: "idle",
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

function writeRequestStatus(document: Y.Doc, requestId: string, patch: Record<string, unknown>): void {
  const requests = document.getMap<Record<string, unknown>>("agentInstructionRequests");
  const current = requests.get(requestId);
  requests.set(requestId, {
    ...(isRecord(current) ? current : {}),
    ...patch,
  });
}

function startAgentPresence(
  provider: HocuspocusProvider,
  document: Y.Doc,
  request: AgentRunQueueRequest,
): {
  finish(message: string, status: "proposed" | "failed"): void;
  stop(): void;
  update(message: string): void;
} {
  const awareness = provider.awareness;
  const area = chooseAgentPlannedArea(document);
  const logs: string[] = [];
  let step = 0;
  let stopped = false;
  const cursorPath = [
    { x: area.x + 32, y: area.y + 32 },
    { x: area.x + area.width - 48, y: area.y + 48 },
    { x: area.x + area.width - 72, y: area.y + area.height - 44 },
    { x: area.x + 48, y: area.y + area.height - 56 },
  ];

  const publish = (status: "running" | "proposed" | "failed", message: string) => {
    if (!awareness || stopped) {
      return;
    }

    const point = cursorPath[step % cursorPath.length];
    step += 1;
    awareness.setLocalStateField("user", {
      name: "Agent",
      color: status === "failed" ? "#d32f2f" : "#6965db",
      colorLight: status === "failed" ? "#ffe3e3" : "#e0dfff",
      role: "agent",
      state: message,
    });
    awareness.setLocalStateField("pointer", {
      ...point,
      tool: "pointer",
    });
    awareness.setLocalStateField("button", "up");
    awareness.setLocalStateField("agentPresence", {
      schemaVersion: 1,
      fileId: request.fileId,
      runId: request.runId,
      requestId: request.requestId,
      status,
      message,
      logs: logs.slice(-5),
      plannedArea: area,
      updatedAt: Date.now(),
    });
  };

  const update = (message: string) => {
    logs.push(message);
    publish("running", message);
  };
  update("Agent が描画予定領域を確保しています");

  const timer = setInterval(() => {
    publish("running", logs.at(-1) ?? "Agent が作業中です");
  }, 700);

  return {
    finish(message, status) {
      logs.push(message);
      publish(status, message);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      awareness?.setLocalStateField("pointer", null);
      awareness?.setLocalStateField("button", "up");
    },
    update,
  };
}

function chooseAgentPlannedArea(document: Y.Doc): { x: number; y: number; width: number; height: number } {
  const elements = readVisibleElements(document);
  const bounds = readElementsBounds(elements);
  const width = 680;
  const height = 420;

  if (!bounds) {
    return { x: 120, y: 120, width, height };
  }

  return {
    x: bounds.maxX + 96,
    y: bounds.minY,
    width,
    height,
  };
}

function createDemoProposalElements(document: Y.Doc, request: AgentRunQueueRequest): Record<string, unknown>[] {
  const area = chooseAgentPlannedArea(document);
  const notePrompt = readLatestNotePrompt(document);
  const title = notePrompt ?? request.prompt.split("\n").find(Boolean) ?? "Agent proposal";
  const now = Date.now();
  const groupId = `agent-demo-${request.runId}`;
  const elements: Record<string, unknown>[] = [];

  elements.push(createRectangle({
    id: `${request.runId}-proposal-frame`,
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    strokeColor: "#6965db",
    backgroundColor: "#f8f7ff",
    groupIds: [groupId],
    now,
  }));
  elements.push(createText({
    id: `${request.runId}-proposal-title`,
    x: area.x + 28,
    y: area.y + 22,
    width: area.width - 56,
    height: 42,
    text: `Agent draft: ${truncate(title, 42)}`,
    fontSize: 24,
    strokeColor: "#2f2a85",
    groupIds: [groupId],
    now,
  }));

  const cardWidth = 280;
  const cardHeight = 116;
  const cards = [
    ["Sources / raw", "入力・画像・Noteを素材として整理"],
    ["Intermediate artifacts", "理解用の構造化ノートを作成"],
    ["Knowledge artifacts", "再利用できる概念へ分解"],
    ["Assets", "参照画像やdiagram素材を保存"],
  ];

  cards.forEach(([heading, body], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = area.x + 36 + column * (cardWidth + 44);
    const y = area.y + 92 + row * (cardHeight + 42);
    elements.push(createRectangle({
      id: `${request.runId}-proposal-card-${index}`,
      x,
      y,
      width: cardWidth,
      height: cardHeight,
      strokeColor: column === 0 ? "#3f51b5" : "#2b8a3e",
      backgroundColor: "#ffffff",
      groupIds: [groupId],
      now,
    }));
    elements.push(createText({
      id: `${request.runId}-proposal-card-${index}-text`,
      x: x + 18,
      y: y + 18,
      width: cardWidth - 36,
      height: cardHeight - 30,
      text: `${index + 1}. ${heading}\n${body}`,
      fontSize: 17,
      strokeColor: "#263238",
      groupIds: [groupId],
      now,
    }));
  });

  elements.push(createText({
    id: `${request.runId}-proposal-caption`,
    x: area.x + 36,
    y: area.y + area.height - 56,
    width: area.width - 72,
    height: 32,
    text: "※ v1動作確認: Worker がYjsへ ghost proposal を publish",
    fontSize: 15,
    strokeColor: "#5f6368",
    groupIds: [groupId],
    now,
  }));

  return elements;
}

function createRectangle(input: {
  backgroundColor: string;
  groupIds: string[];
  height: number;
  id: string;
  now: number;
  strokeColor: string;
  width: number;
  x: number;
  y: number;
}): Record<string, unknown> {
  return {
    ...createBaseElement(input),
    type: "rectangle",
    backgroundColor: input.backgroundColor,
    roundness: { type: 3 },
  };
}

function createText(input: {
  fontSize: number;
  groupIds: string[];
  height: number;
  id: string;
  now: number;
  strokeColor: string;
  text: string;
  width: number;
  x: number;
  y: number;
}): Record<string, unknown> {
  return {
    ...createBaseElement({
      ...input,
      backgroundColor: "transparent",
    }),
    type: "text",
    backgroundColor: "transparent",
    roundness: null,
    text: input.text,
    originalText: input.text,
    fontSize: input.fontSize,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: 1.25,
  };
}

function createBaseElement(input: {
  backgroundColor: string;
  groupIds: string[];
  height: number;
  id: string;
  now: number;
  strokeColor: string;
  width: number;
  x: number;
  y: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    angle: 0,
    strokeColor: input.strokeColor,
    backgroundColor: input.backgroundColor,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: input.groupIds,
    frameId: null,
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: null,
    updated: input.now,
    link: null,
    locked: false,
  };
}

function readLatestNotePrompt(document: Y.Doc): string | null {
  const notes = Object.values(document.getMap("notes").toJSON())
    .map(getNoteText)
    .filter((text): text is string => Boolean(text));
  return notes.at(-1) ?? null;
}

function readVisibleElements(document: Y.Doc): Record<string, unknown>[] {
  return document
    .getArray<Y.Map<unknown>>("elements")
    .toArray()
    .map((item) => item.get("el"))
    .filter((element): element is Record<string, unknown> =>
      isRecord(element) &&
      element.isDeleted !== true &&
      typeof element.x === "number" &&
      typeof element.y === "number" &&
      typeof element.width === "number" &&
      typeof element.height === "number",
    );
}

function readElementsBounds(elements: Record<string, unknown>[]): {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
} | null {
  if (elements.length === 0) {
    return null;
  }

  return elements.reduce<{
    maxX: number;
    maxY: number;
    minX: number;
    minY: number;
  }>((bounds, element) => {
    const x = element.x as number;
    const y = element.y as number;
    const width = element.width as number;
    const height = element.height as number;
    return {
      minX: Math.min(bounds.minX, x),
      minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x + width),
      maxY: Math.max(bounds.maxY, y + height),
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
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
