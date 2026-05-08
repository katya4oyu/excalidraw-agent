import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunQueueRequest, AgentWorkerOptions, DerivedPatch } from "@excalidraw-agent/shared";
import { createBaseRevisionSnapshot } from "@excalidraw-agent/shared";
import type * as Y from "yjs";

export const finalArtifactFileName = "final.excalidraw";
export const baseSceneFileName = "base-scene.json";
export const derivedPatchFileName = "derived.patch.json";
export const estimateFileName = "estimate.json";
export const humanDeltasFileName = "human-deltas.jsonl";
export const qualityReportFileName = "quality-report.json";

export interface RunSnapshot {
  baseRevision: string;
  plannedArea?: PlannedArea;
  runDirectory: string;
  snapshotPath: string;
}

export interface PlannedArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentRunEstimate {
  estimatedBounds: PlannedArea;
  targetIntent: string;
  layoutRationale: string;
  steps: AgentRunEstimateStep[];
}

export interface AgentRunEstimateStep {
  id: string;
  title: string;
  instruction: string;
}

export interface HumanDelta {
  changedAt: string;
  summary: string;
  elementCountBefore: number;
  elementCountAfter: number;
  noteCountBefore: number;
  noteCountAfter: number;
}

export interface QualityReport {
  status: "passed" | "failed";
  checkedAt: string;
  finalArtifactPath: string;
  structureOk: boolean;
  plannedAreaOk: boolean;
  visualOk: boolean;
  proposedElementCount: number;
  messages: string[];
  refined: boolean;
}

export interface FinalProposalResult {
  finalArtifactPath: string;
  patch: DerivedPatch;
  proposedElements: Record<string, unknown>[];
}

export type FinalProposalReadResult =
  | { status: "loaded"; finalArtifactPath: string; proposal: FinalProposalResult }
  | { status: "missing"; finalArtifactPath: string }
  | { status: "unreadable"; error: string; finalArtifactPath: string };

export function buildPrompt(
  options: AgentWorkerOptions,
  prompt = options.prompt,
  request?: AgentRunQueueRequest,
  snapshotPath?: string,
): string {
  const finalArtifactRelativePath = request ? join("runs", request.runId, finalArtifactFileName) : undefined;

  return [
    `対象ファイルID: ${options.fileId}`,
    request ? `Agent run ID: ${request.runId}` : "",
    request ? `Instruction request ID: ${request.requestId}` : "",
    snapshotPath ? `同期済みキャンバス snapshot: ${snapshotPath}` : "",
    finalArtifactRelativePath ? `成果物: ${finalArtifactRelativePath}` : "",
    "",
    "この作業スペースの AGENTS.md を読み、Excalidraw作業では .agents/skills/excalidraw-skill/SKILL.md を使ってください。",
    "MCP tools が使えない場合は、skill の REST API mode または付属 scripts を使ってください。",
    ".excalidraw ファイルはこの作業スペース内に作成してください。",
    snapshotPath ? "作業開始時には必ず snapshot JSON を読み、現在の canvas 要素・notes・agentRuns を確認してください。" : "",
    snapshotPath ? "snapshot JSON の plannedArea が提案の予定地です。新規要素はこの予定地の中、または明確に重なる位置に配置してください。" : "",
    finalArtifactRelativePath
      ? `完了時は必ず ${finalArtifactRelativePath} に最終 Excalidraw scene を保存してください。Worker はこのファイルを読み、base-scene.json との差分から proposal を作ります。`
      : "",
    finalArtifactRelativePath
      ? "最後の回答で追加調整を次回へ先送りしないでください。現在の instruction に対して、この run 内で可能な限り完成度を上げてください。"
      : "",
    "",
    prompt ?? "現在はセットアップ確認として、利用できる作業手順を短く確認してください。",
  ].filter((line, index) => line || index > 2).join("\n");
}

export function buildEstimatePrompt(
  options: AgentWorkerOptions,
  request: AgentRunQueueRequest,
  snapshot: RunSnapshot,
): string {
  return [
    `対象ファイルID: ${options.fileId}`,
    `Agent run ID: ${request.runId}`,
    `Instruction request ID: ${request.requestId}`,
    `同期済みキャンバス snapshot: ${snapshot.snapshotPath}`,
    `見積もり成果物: ${join("runs", request.runId, estimateFileName)}`,
    "",
    "AGENTS.md を読み、snapshot JSON の elements・notes・agentRuns・agentProposals を確認してください。",
    "このturnでは図を作らず、作成予定の図に必要な領域と作成stepだけを見積もってください。",
    "必ずJSONだけを estimate.json に保存してください。schemaは { estimatedBounds:{x,y,width,height}, targetIntent, layoutRationale, steps:[{id,title,instruction}] } です。",
    "estimatedBounds は希望値であり、Workerが衝突回避して最終plannedAreaを決めます。",
    "",
    request.prompt,
  ].join("\n");
}

export function buildDraftStepPrompt(input: {
  options: AgentWorkerOptions;
  request: AgentRunQueueRequest;
  snapshot: RunSnapshot;
  estimate: AgentRunEstimate;
  step: AgentRunEstimateStep;
  stepIndex: number;
  humanDeltas: HumanDelta[];
}): string {
  return [
    `対象ファイルID: ${input.options.fileId}`,
    `Agent run ID: ${input.request.runId}`,
    `draft step: ${input.stepIndex + 1}/${input.estimate.steps.length}`,
    `同期済みキャンバス snapshot: ${input.snapshot.snapshotPath}`,
    `plannedArea: ${JSON.stringify(input.snapshot.plannedArea)}`,
    `draft成果物: ${join("runs", input.request.runId, draftStepFileName(input.stepIndex))}`,
    "",
    "このturnでは指定stepまでを反映した Excalidraw scene を draft-step ファイルへ保存してください。",
    "既存sceneを維持し、新規要素はplannedArea内または明確に重なる位置へ配置してください。",
    "humanDelta がある場合は、作業中に人間が変更した内容として必ず反映してください。",
    `targetIntent: ${input.estimate.targetIntent}`,
    `step title: ${input.step.title}`,
    `step instruction: ${input.step.instruction}`,
    input.humanDeltas.length > 0 ? `humanDelta: ${JSON.stringify(input.humanDeltas.slice(-5))}` : "humanDelta: []",
    "",
    input.request.prompt,
  ].join("\n");
}

export function buildFinalPrompt(input: {
  options: AgentWorkerOptions;
  request: AgentRunQueueRequest;
  snapshot: RunSnapshot;
  estimate: AgentRunEstimate;
  humanDeltas: HumanDelta[];
  refineFrom?: QualityReport;
}): string {
  return [
    `対象ファイルID: ${input.options.fileId}`,
    `Agent run ID: ${input.request.runId}`,
    `同期済みキャンバス snapshot: ${input.snapshot.snapshotPath}`,
    `plannedArea: ${JSON.stringify(input.snapshot.plannedArea)}`,
    `成果物: ${join("runs", input.request.runId, finalArtifactFileName)}`,
    "",
    "これまでのdraft stepを統合し、最終 Excalidraw scene を final.excalidraw に保存してください。",
    "既存要素を不自然に覆わず、新規要素はplannedArea内または明確に重なる位置へ配置してください。",
    "最後の回答で追加調整を次回へ先送りしないでください。このrun内で完成させてください。",
    `targetIntent: ${input.estimate.targetIntent}`,
    `steps: ${JSON.stringify(input.estimate.steps)}`,
    input.humanDeltas.length > 0 ? `humanDelta: ${JSON.stringify(input.humanDeltas.slice(-5))}` : "humanDelta: []",
    input.refineFrom ? `前回quality report: ${JSON.stringify(input.refineFrom)}` : "",
    "",
    input.request.prompt,
  ].filter(Boolean).join("\n");
}

export function writeRunSnapshot(
  workspace: string,
  document: Y.Doc,
  request: AgentRunQueueRequest,
  plannedArea?: PlannedArea,
): RunSnapshot {
  const runDirectory = getRunDirectory(workspace, request.runId);
  mkdirSync(runDirectory, { recursive: true });

  const elements = document.getArray<Y.Map<unknown>>("elements").toArray().map((item) => item.get("el"));
  const assets = document.getMap("assets").toJSON();
  const notes = document.getMap("notes").toJSON();
  const baseRevision = createBaseRevisionSnapshot({
    elements: elements.filter((element): element is Record<string, unknown> => isRecord(element) && !isAgentManagedElement(element)),
    assets,
    notes,
  }).hash;
  const snapshotPath = join(runDirectory, baseSceneFileName);
  writeFileSync(join(runDirectory, humanDeltasFileName), "");
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      fileId: request.fileId,
      requestId: request.requestId,
      runId: request.runId,
      prompt: request.prompt,
      baseRevision,
      plannedArea,
      capturedAt: new Date().toISOString(),
      elements,
      assets,
      notes,
      agentRuns: document.getMap("agentRuns").toJSON(),
      agentProposals: document.getMap("agentProposals").toJSON(),
    }, null, 2),
  );

  return { baseRevision, plannedArea, runDirectory, snapshotPath };
}

export function readEstimate(snapshot: RunSnapshot, documentElements: Record<string, unknown>[] = []): AgentRunEstimate {
  const estimatePath = join(snapshot.runDirectory, estimateFileName);
  if (existsSync(estimatePath)) {
    const estimate = JSON.parse(readFileSync(estimatePath, "utf8")) as unknown;
    if (isAgentRunEstimate(estimate)) {
      return normalizeEstimate(estimate);
    }
  }

  return createFallbackEstimate(documentElements);
}

export function resolvePlannedArea(
  estimate: AgentRunEstimate,
  existingElements: Record<string, unknown>[],
): PlannedArea {
  const width = clamp(estimate.estimatedBounds.width, 240, 960);
  const height = clamp(estimate.estimatedBounds.height, 180, 720);
  const preferred = {
    x: estimate.estimatedBounds.x,
    y: estimate.estimatedBounds.y,
    width,
    height,
  };
  const filteredElements = existingElements.filter((element) => !isAgentManagedElement(element));
  if (!collidesWithElements(preferred, filteredElements)) {
    return preferred;
  }

  const bounds = readElementsBounds(filteredElements);
  if (!bounds) {
    return { x: 120, y: 120, width, height };
  }

  const candidates = [
    { x: bounds.maxX + 96, y: bounds.minY, width, height },
    { x: bounds.minX, y: bounds.maxY + 96, width, height },
    { x: bounds.minX - width - 96, y: bounds.minY, width, height },
    { x: bounds.minX, y: bounds.minY - height - 96, width, height },
  ];
  return candidates.find((candidate) => !collidesWithElements(candidate, filteredElements)) ?? candidates[0];
}

export function updateSnapshotPlannedArea(snapshot: RunSnapshot, plannedArea: PlannedArea): RunSnapshot {
  const current = JSON.parse(readFileSync(snapshot.snapshotPath, "utf8")) as Record<string, unknown>;
  writeFileSync(snapshot.snapshotPath, JSON.stringify({ ...current, plannedArea }, null, 2));
  return { ...snapshot, plannedArea };
}

export function draftStepFileName(stepIndex: number): string {
  return `draft-step-${stepIndex + 1}.excalidraw`;
}

export function readDraftStepProposal(snapshot: RunSnapshot, stepIndex: number): FinalProposalReadResult {
  return readProposalArtifact(snapshot, draftStepFileName(stepIndex), false);
}

export function appendHumanDelta(snapshot: RunSnapshot, delta: HumanDelta): void {
  appendFileSync(join(snapshot.runDirectory, humanDeltasFileName), `${JSON.stringify(delta)}\n`);
}

export function writeQualityReport(snapshot: RunSnapshot, report: QualityReport): void {
  writeFileSync(join(snapshot.runDirectory, qualityReportFileName), JSON.stringify(report, null, 2));
}

export function assessFinalProposal(snapshot: RunSnapshot, result: FinalProposalReadResult, refined: boolean): QualityReport {
  const messages: string[] = [];
  const proposedElementCount = result.status === "loaded" ? result.proposal.proposedElements.length : 0;
  const structureOk = result.status === "loaded";
  const plannedAreaOk = structureOk && elementsOverlapPlannedArea(result.proposal.proposedElements, snapshot.plannedArea);
  const visualOk = structureOk && proposedElementCount > 0;

  if (!structureOk) {
    messages.push(result.status === "unreadable" ? result.error : "final.excalidraw is missing");
  }
  if (!plannedAreaOk) {
    messages.push("proposal does not overlap plannedArea");
  }
  if (!visualOk) {
    messages.push("proposal has no visible add elements");
  }

  return {
    status: structureOk && plannedAreaOk && visualOk ? "passed" : "failed",
    checkedAt: new Date().toISOString(),
    finalArtifactPath: result.finalArtifactPath,
    structureOk,
    plannedAreaOk,
    visualOk,
    proposedElementCount,
    messages,
    refined,
  };
}

export function readFinalProposal(snapshot: RunSnapshot): FinalProposalReadResult {
  return readProposalArtifact(snapshot, finalArtifactFileName, true);
}

function readProposalArtifact(
  snapshot: RunSnapshot,
  artifactFileName: string,
  writeDerivedPatch: boolean,
): FinalProposalReadResult {
  const finalArtifactPath = join(snapshot.runDirectory, artifactFileName);
  if (!existsSync(finalArtifactPath)) {
    return { status: "missing", finalArtifactPath };
  }

  try {
    const finalScene = JSON.parse(readFileSync(finalArtifactPath, "utf8")) as unknown;
    const baseScene = JSON.parse(readFileSync(snapshot.snapshotPath, "utf8")) as unknown;
    const plannedArea = readPlannedArea(baseScene) ?? snapshot.plannedArea;
    const patch = derivePatchFromScenes({
      baseRevision: readBaseRevision(baseScene) ?? snapshot.baseRevision,
      baseScene,
      finalScene,
      plannedArea,
    });
    if (writeDerivedPatch) {
      const patchPath = join(snapshot.runDirectory, derivedPatchFileName);
      writeFileSync(patchPath, JSON.stringify(patch, null, 2));
    }

    return {
      status: "loaded",
      finalArtifactPath,
      proposal: {
        finalArtifactPath,
        patch,
        proposedElements: patch.operations.flatMap((operation) => operation.type === "add" ? [operation.element] : []),
      },
    };
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
      finalArtifactPath,
    };
  }
}

export function derivePatchFromScenes(input: {
  baseRevision: string;
  baseScene: unknown;
  finalScene: unknown;
  plannedArea?: PlannedArea;
  now?: number;
}): DerivedPatch {
  const baseElements = readVisibleElements(input.baseScene);
  const finalElements = readVisibleElements(input.finalScene);
  const baseById = new Map(baseElements.map((element) => [String(element.id), element]));
  const finalById = new Map(finalElements.map((element) => [String(element.id), element]));
  const operations: DerivedPatch["operations"] = [];

  for (const element of finalElements) {
    const id = String(element.id);
    const baseElement = baseById.get(id);
    if (!baseElement) {
      operations.push({ type: "add", element });
      continue;
    }

    if (isMoved(baseElement, element)) {
      operations.push({ type: "unsupported", reason: "move", elementId: id });
      continue;
    }

    if (stableStringify(baseElement) !== stableStringify(element)) {
      operations.push({ type: "unsupported", reason: "update", elementId: id });
    }
  }

  for (const element of baseElements) {
    const id = String(element.id);
    if (!finalById.has(id)) {
      operations.push({ type: "unsupported", reason: "delete", elementId: id });
    }
  }

  const alignedOperations = input.plannedArea
    ? alignAddOperationsToPlannedArea(operations, input.plannedArea)
    : operations;

  return {
    schemaVersion: 1,
    baseRevision: input.baseRevision,
    operations: alignedOperations,
    unsupportedCount: alignedOperations.filter((operation) => operation.type === "unsupported").length,
    createdAt: input.now ?? Date.now(),
  };
}

function alignAddOperationsToPlannedArea(
  operations: DerivedPatch["operations"],
  plannedArea: PlannedArea,
): DerivedPatch["operations"] {
  const addedElements = operations.flatMap((operation) => operation.type === "add" ? [operation.element] : []);
  const bounds = readElementsBounds(addedElements);
  if (!bounds || intersects(bounds, plannedArea)) {
    return operations;
  }

  const dx = plannedArea.x + 24 - bounds.minX;
  const dy = plannedArea.y + 24 - bounds.minY;
  return operations.map((operation) => operation.type === "add"
    ? { ...operation, element: translateElement(operation.element, dx, dy) }
    : operation);
}

function translateElement(element: Record<string, unknown>, dx: number, dy: number): Record<string, unknown> {
  const x = typeof element.x === "number" ? element.x + dx : element.x;
  const y = typeof element.y === "number" ? element.y + dy : element.y;
  return {
    ...element,
    x,
    y,
  };
}

function readElementsBounds(elements: Record<string, unknown>[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    if (
      typeof element.x !== "number" ||
      typeof element.y !== "number" ||
      typeof element.width !== "number" ||
      typeof element.height !== "number"
    ) {
      continue;
    }

    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + Math.max(1, element.width));
    maxY = Math.max(maxY, element.y + Math.max(1, element.height));
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function intersects(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  area: PlannedArea,
): boolean {
  return bounds.maxX >= area.x &&
    bounds.minX <= area.x + area.width &&
    bounds.maxY >= area.y &&
    bounds.minY <= area.y + area.height;
}

function getRunDirectory(workspace: string, runId: string): string {
  return join(workspace, "runs", runId);
}

function readVisibleElements(scene: unknown): Record<string, unknown>[] {
  if (!isRecord(scene) || !Array.isArray(scene.elements)) {
    throw new Error("Excalidraw scene must contain an elements array");
  }

  return scene.elements.filter((element): element is Record<string, unknown> =>
    isRecord(element) &&
    typeof element.id === "string" &&
    element.isDeleted !== true &&
    !isAgentManagedElement(element),
  );
}

function readBaseRevision(scene: unknown): string | null {
  return isRecord(scene) && typeof scene.baseRevision === "string" ? scene.baseRevision : null;
}

function readPlannedArea(scene: unknown): PlannedArea | undefined {
  if (!isRecord(scene) || !isRecord(scene.plannedArea)) {
    return undefined;
  }
  const area = scene.plannedArea;
  if (
    typeof area.x !== "number" ||
    typeof area.y !== "number" ||
    typeof area.width !== "number" ||
    typeof area.height !== "number"
  ) {
    return undefined;
  }
  return {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
  };
}

function isMoved(baseElement: Record<string, unknown>, finalElement: Record<string, unknown>): boolean {
  return baseElement.x !== finalElement.x || baseElement.y !== finalElement.y;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEstimate(estimate: AgentRunEstimate): AgentRunEstimate {
  return {
    estimatedBounds: {
      x: estimate.estimatedBounds.x,
      y: estimate.estimatedBounds.y,
      width: estimate.estimatedBounds.width,
      height: estimate.estimatedBounds.height,
    },
    targetIntent: estimate.targetIntent,
    layoutRationale: estimate.layoutRationale,
    steps: estimate.steps.length > 0 ? estimate.steps.slice(0, 4) : createDefaultSteps(),
  };
}

function createFallbackEstimate(elements: Record<string, unknown>[]): AgentRunEstimate {
  const bounds = readElementsBounds(elements.filter((element) => !isAgentManagedElement(element)));
  return {
    estimatedBounds: bounds
      ? { x: bounds.maxX + 96, y: bounds.minY, width: 680, height: 420 }
      : { x: 120, y: 120, width: 680, height: 420 },
    targetIntent: "Create a focused Excalidraw proposal from the current canvas request.",
    layoutRationale: "Fallback estimate based on current visible canvas bounds.",
    steps: createDefaultSteps(),
  };
}

function createDefaultSteps(): AgentRunEstimateStep[] {
  return [
    { id: "structure", title: "Structure", instruction: "Create the main layout and bounding shapes." },
    { id: "details", title: "Details", instruction: "Add the important visual or diagram details." },
  ];
}

function isAgentRunEstimate(value: unknown): value is AgentRunEstimate {
  return isRecord(value) &&
    isRecord(value.estimatedBounds) &&
    typeof value.estimatedBounds.x === "number" &&
    typeof value.estimatedBounds.y === "number" &&
    typeof value.estimatedBounds.width === "number" &&
    typeof value.estimatedBounds.height === "number" &&
    typeof value.targetIntent === "string" &&
    typeof value.layoutRationale === "string" &&
    Array.isArray(value.steps) &&
    value.steps.every((step) =>
      isRecord(step) &&
      typeof step.id === "string" &&
      typeof step.title === "string" &&
      typeof step.instruction === "string"
    );
}

function collidesWithElements(area: PlannedArea, elements: Record<string, unknown>[]): boolean {
  return elements.some((element) => {
    if (
      typeof element.x !== "number" ||
      typeof element.y !== "number" ||
      typeof element.width !== "number" ||
      typeof element.height !== "number"
    ) {
      return false;
    }
    return intersects({
      minX: element.x,
      minY: element.y,
      maxX: element.x + Math.max(1, element.width),
      maxY: element.y + Math.max(1, element.height),
    }, area);
  });
}

function elementsOverlapPlannedArea(elements: Record<string, unknown>[], plannedArea?: PlannedArea): boolean {
  if (!plannedArea) {
    return true;
  }
  const bounds = readElementsBounds(elements);
  return Boolean(bounds && intersects(bounds, plannedArea));
}

function isAgentManagedElement(element: Record<string, unknown>): boolean {
  const customData = element.customData;
  if (!isRecord(customData)) {
    return false;
  }
  const metadata = customData.excalidrawAgent;
  return isRecord(metadata) && metadata.kind === "ghost";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
