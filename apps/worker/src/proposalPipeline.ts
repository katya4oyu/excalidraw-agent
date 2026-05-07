import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunQueueRequest, AgentWorkerOptions, DerivedPatch } from "@excalidraw-agent/shared";
import { createBaseRevisionSnapshot } from "@excalidraw-agent/shared";
import type * as Y from "yjs";

export const finalArtifactFileName = "final.excalidraw";
export const baseSceneFileName = "base-scene.json";
export const derivedPatchFileName = "derived.patch.json";

export interface RunSnapshot {
  baseRevision: string;
  runDirectory: string;
  snapshotPath: string;
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
    finalArtifactRelativePath
      ? `完了時は必ず ${finalArtifactRelativePath} に最終 Excalidraw scene を保存してください。Worker はこのファイルを読み、base-scene.json との差分から proposal を作ります。`
      : "",
    "",
    prompt ?? "現在はセットアップ確認として、利用できる作業手順を短く確認してください。",
  ].filter((line, index) => line || index > 2).join("\n");
}

export function writeRunSnapshot(workspace: string, document: Y.Doc, request: AgentRunQueueRequest): RunSnapshot {
  const runDirectory = getRunDirectory(workspace, request.runId);
  mkdirSync(runDirectory, { recursive: true });

  const elements = document.getArray<Y.Map<unknown>>("elements").toArray().map((item) => item.get("el"));
  const assets = document.getMap("assets").toJSON();
  const notes = document.getMap("notes").toJSON();
  const baseRevision = createBaseRevisionSnapshot({
    elements: elements.filter(isRecord),
    assets,
    notes,
  }).hash;
  const snapshotPath = join(runDirectory, baseSceneFileName);
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      fileId: request.fileId,
      requestId: request.requestId,
      runId: request.runId,
      prompt: request.prompt,
      baseRevision,
      capturedAt: new Date().toISOString(),
      elements,
      assets,
      notes,
      agentRuns: document.getMap("agentRuns").toJSON(),
      agentProposals: document.getMap("agentProposals").toJSON(),
    }, null, 2),
  );

  return { baseRevision, runDirectory, snapshotPath };
}

export function readFinalProposal(snapshot: RunSnapshot): FinalProposalReadResult {
  const finalArtifactPath = join(snapshot.runDirectory, finalArtifactFileName);
  if (!existsSync(finalArtifactPath)) {
    return { status: "missing", finalArtifactPath };
  }

  try {
    const finalScene = JSON.parse(readFileSync(finalArtifactPath, "utf8")) as unknown;
    const baseScene = JSON.parse(readFileSync(snapshot.snapshotPath, "utf8")) as unknown;
    const patch = derivePatchFromScenes({
      baseRevision: readBaseRevision(baseScene) ?? snapshot.baseRevision,
      baseScene,
      finalScene,
    });
    const patchPath = join(snapshot.runDirectory, derivedPatchFileName);
    writeFileSync(patchPath, JSON.stringify(patch, null, 2));

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

  return {
    schemaVersion: 1,
    baseRevision: input.baseRevision,
    operations,
    unsupportedCount: operations.filter((operation) => operation.type === "unsupported").length,
    createdAt: input.now ?? Date.now(),
  };
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
    element.isDeleted !== true,
  );
}

function readBaseRevision(scene: unknown): string | null {
  return isRecord(scene) && typeof scene.baseRevision === "string" ? scene.baseRevision : null;
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
