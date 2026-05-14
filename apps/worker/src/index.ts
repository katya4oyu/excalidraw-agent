import { HocuspocusProvider } from "@hocuspocus/provider";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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
import { publishGhostDraft, publishGhostProposal, removeGhostDraft } from "@excalidraw-agent/y-excalidraw-agent";
import {
  appendHumanDelta,
  assessFinalProposal,
  buildDraftStepPrompt,
  buildEstimatePrompt,
  buildFinalPrompt,
  buildPrompt,
  derivedPatchFileName,
  readDraftStepProposal,
  readEstimate,
  readFinalProposal,
  resolvePlannedArea,
  updateSnapshotPlannedArea,
  writeQualityReport,
  writeRunSnapshot,
  type HumanDelta,
  type PlannedArea,
} from "./proposalPipeline.ts";
import { createTypeScriptSdkCodexRuntime } from "./runtime.ts";
import type { CodexRuntime, CodexRuntimeEvent } from "./runtime.ts";

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

  const runtime = createCodexRuntime(options, workspace);

  const result = await runtime.run({ prompt: buildPrompt(options, options.prompt) });
  console.log(result.finalResponse);
}

async function runDaemon(options: AgentWorkerOptions): Promise<void> {
  const workspace = prepareWorkspace(options);
  let running = false;
  const queue: AgentRunQueueRequest[] = [];
  const prepareOnly = process.env.EXCALIDRAW_AGENT_PREPARE_ONLY === "true";
  const collab = prepareOnly ? null : await connectFileDocument(options);
  const runtime = prepareOnly ? null : createCodexRuntime(options, workspace);

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
    let presence: ReturnType<typeof startAgentPresence> | null = null;
    collab?.document.transact(() => {
      writeRunStatus(collab.document, request.runId, {
        status: "running",
        phase: "estimating",
        requestId: request.requestId,
        prompt: request.prompt,
        updatedAt: Date.now(),
      });
    });

    try {
      let codexError: string | undefined;
      let codexFinalResponse: string | undefined;
      if (!collab) {
        throw new Error("Worker collab connection is not available");
      }
      if (!runtime) {
        throw new Error("Codex runtime is not available");
      }

      let snapshot = writeRunSnapshot(workspace, collab.document, request);
      const humanDeltas: HumanDelta[] = [];
      const runCodexTurn = async (phase: string, prompt: string): Promise<void> => {
        const before = captureHumanSceneState(collab.document);
        writeRunStatus(collab.document, request.runId, {
          phase,
          humanDeltaCount: humanDeltas.length,
          updatedAt: Date.now(),
        });
        const result = await runtime.run({
          prompt,
          onEvent: (event) => {
            handleRuntimeEvent(event, presence);
          },
        });
        const delta = diffHumanSceneState(before, captureHumanSceneState(collab.document));
        if (delta) {
          humanDeltas.push(delta);
          appendHumanDelta(snapshot, delta);
        }
        if (result.finalResponse) {
          codexFinalResponse = result.finalResponse;
          console.log(result.finalResponse);
        }
      };

      await runCodexTurn("estimating", buildEstimatePrompt(options, request, snapshot));
      const estimate = readEstimate(snapshot, readVisibleElements(collab.document));
      const plannedArea = resolvePlannedArea(estimate, readVisibleElements(collab.document));
      snapshot = updateSnapshotPlannedArea(snapshot, plannedArea);
      presence = startAgentPresence(collab.provider, request, plannedArea);
      presence.update("Codex見積もりから描画予定領域を確定しました");
      writeRunStatus(collab.document, request.runId, {
        phase: "planning",
        plannedArea,
        estimate,
        humanDeltaCount: humanDeltas.length,
        updatedAt: Date.now(),
      });

      for (const [stepIndex, step] of estimate.steps.entries()) {
        presence.update(`draft step ${stepIndex + 1}/${estimate.steps.length}: ${step.title}`);
        await runCodexTurn("drafting", buildDraftStepPrompt({
          options,
          request,
          snapshot,
          estimate,
          step,
          stepIndex,
          humanDeltas,
        }));
        const draftProposal = readDraftStepProposal(snapshot, stepIndex);
        if (draftProposal.status === "loaded" && draftProposal.proposal.proposedElements.length > 0) {
          collab.document.transact(() => {
            publishGhostDraft(
              {
                elements: collab.document.getArray<Y.Map<unknown>>("elements"),
                agentRuns: collab.document.getMap("agentRuns"),
              },
              {
                runId: request.runId,
                stepIndex,
                elements: draftProposal.proposal.proposedElements,
                baseRevision: snapshot.baseRevision,
              },
            );
            writeRunStatus(collab.document, request.runId, {
              phase: "drafting",
              humanDeltaCount: humanDeltas.length,
              updatedAt: Date.now(),
            });
          });
        }
      }

      presence.update("final.excalidraw を作成し、品質チェックを行います");
      await runCodexTurn("verifying", buildFinalPrompt({ options, request, snapshot, estimate, humanDeltas }));
      let finalProposal = readFinalProposal(snapshot);
      let qualityReport = assessFinalProposal(snapshot, finalProposal, false);
      writeQualityReport(snapshot, qualityReport);
      if (qualityReport.status === "failed") {
        presence.update("品質チェックに失敗したため、Codexに1回だけ修正させます");
        await runCodexTurn("verifying", buildFinalPrompt({
          options,
          request,
          snapshot,
          estimate,
          humanDeltas,
          refineFrom: qualityReport,
        }));
        finalProposal = readFinalProposal(snapshot);
        qualityReport = assessFinalProposal(snapshot, finalProposal, true);
        writeQualityReport(snapshot, qualityReport);
      }
      if (qualityReport.status !== "passed" || finalProposal.status !== "loaded") {
        throw new Error(`Final proposal quality check failed: ${qualityReport.messages.join("; ")}`);
      }

      const proposedElements = finalProposal.proposal.proposedElements;
      const derivedPatch = finalProposal.proposal.patch;
      const finalArtifactPath = finalProposal.finalArtifactPath;
      collab?.document.transact(() => {
        const finishedAt = Date.now();
        removeGhostDraft(
          {
            elements: collab.document.getArray<Y.Map<unknown>>("elements"),
            agentRuns: collab.document.getMap("agentRuns"),
          },
          request.runId,
          finishedAt,
        );
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
            baseRevision: snapshot.baseRevision,
            source: "codex-final-artifact",
            createdAt: finishedAt,
          },
        );
        writeRunStatus(collab.document, request.runId, {
          phase: "proposed",
          requestId: request.requestId,
          prompt: request.prompt,
          baseRevision: snapshot.baseRevision,
          plannedArea,
          humanDeltaCount: humanDeltas.length,
          finalArtifactPath,
          derivedPatchPath: join(snapshot.runDirectory, derivedPatchFileName),
          derivedPatchOperationCount: derivedPatch.operations.length,
          unsupportedOperationCount: derivedPatch.unsupportedCount,
          proposalSource: "codex-final-artifact",
          qualityReportPath: join(snapshot.runDirectory, "quality-report.json"),
          ...(codexError ? { codexError } : {}),
          ...(codexFinalResponse ? { codexFinalResponse } : {}),
          finishedAt,
          updatedAt: finishedAt,
          ghostElementIds,
        });
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
        removeGhostDraft(
          {
            elements: collab.document.getArray<Y.Map<unknown>>("elements"),
            agentRuns: collab.document.getMap("agentRuns"),
          },
          request.runId,
          finishedAt,
        );
        writeRunStatus(collab.document, request.runId, {
          status: "failed",
          phase: "failed",
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

function createCodexRuntime(options: AgentWorkerOptions, workspace: string): CodexRuntime {
  return createTypeScriptSdkCodexRuntime({
    env: {
      ...process.env,
      EXPRESS_SERVER_URL: options.serverUrl,
    },
    model: defaultAgentModel,
    workingDirectory: workspace,
    skipGitRepoCheck: true,
  });
}

function handleRuntimeEvent(
  event: CodexRuntimeEvent,
  presence?: { update(message: string): void } | null,
): void {
  if (event.type === "runStarted") {
    presence?.update(event.threadId ? `Codex run を開始しました (${event.threadId})` : "Codex run を開始しました");
    return;
  }

  if (event.type === "finalResponse") {
    presence?.update("Codex の最終応答を受け取りました");
    return;
  }

  if (event.type === "progress") {
    presence?.update(event.message);
    return;
  }

  presence?.update(`Codex error: ${event.error}`);
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

function writeRunStatus(document: Y.Doc, runId: string, patch: Record<string, unknown>): void {
  const agentRuns = document.getMap<Record<string, unknown>>("agentRuns");
  const current = agentRuns.get(runId);
  agentRuns.set(runId, {
    ...(isRecord(current) ? current : {}),
    ...patch,
  });
}

function writeRequestStatus(document: Y.Doc, requestId: string, patch: Record<string, unknown>): void {
  for (const mapName of ["agentRunRequests", "agentInstructionRequests"]) {
    const requests = document.getMap<Record<string, unknown>>(mapName);
    const current = requests.get(requestId);
    if (!current && mapName === "agentInstructionRequests") {
      continue;
    }
    requests.set(requestId, {
      ...(isRecord(current) ? current : {}),
      ...patch,
    });
  }
}

function startAgentPresence(
  provider: HocuspocusProvider,
  request: AgentRunQueueRequest,
  area: PlannedArea,
): {
  finish(message: string, status: "proposed" | "failed"): void;
  stop(): void;
  update(message: string): void;
} {
  const awareness = provider.awareness;
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
      awareness?.setLocalStateField("agentPresence", null);
    },
    update,
  };
}

function chooseAgentPlannedArea(document: Y.Doc): PlannedArea {
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

function createDemoProposalElements(
  document: Y.Doc,
  request: AgentRunQueueRequest,
  plannedArea?: PlannedArea,
): Record<string, unknown>[] {
  const area = plannedArea ?? chooseAgentPlannedArea(document);
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

interface HumanSceneState {
  elements: Record<string, unknown>[];
  notes: unknown[];
  signature: string;
}

function captureHumanSceneState(document: Y.Doc): HumanSceneState {
  const elements = readVisibleElements(document).filter((element) => !isAgentManagedElement(element));
  const notes = Object.values(document.getMap("notes").toJSON());
  return {
    elements,
    notes,
    signature: stableStringify({ elements, notes }),
  };
}

function diffHumanSceneState(before: HumanSceneState, after: HumanSceneState): HumanDelta | null {
  if (before.signature === after.signature) {
    return null;
  }

  return {
    changedAt: new Date().toISOString(),
    summary: `human canvas changed: elements ${before.elements.length}->${after.elements.length}, notes ${before.notes.length}->${after.notes.length}`,
    elementCountBefore: before.elements.length,
    elementCountAfter: after.elements.length,
    noteCountBefore: before.notes.length,
    noteCountAfter: after.notes.length,
  };
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

function isAgentManagedElement(element: Record<string, unknown>): boolean {
  const customData = element.customData;
  if (!isRecord(customData)) {
    return false;
  }
  const metadata = customData.excalidrawAgent;
  return isRecord(metadata) && metadata.kind === "ghost";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toCollabWebSocketUrl(serverUrl: string): string {
  const url = new URL("/collab", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("source", "worker");
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
