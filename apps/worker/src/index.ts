import { Codex } from "@openai/codex-sdk";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentWorkerOptions } from "@excalidraw-agent/shared";

const options = parseArgs(process.argv.slice(2));
const workspace = prepareWorkspace(options);

if (process.env.EXCALIDRAW_AGENT_PREPARE_ONLY === "true") {
  console.log(workspace);
  process.exit(0);
}

const codex = new Codex({
  env: {
    ...process.env,
    EXPRESS_SERVER_URL: options.serverUrl,
  },
});

const thread = codex.startThread({
  workingDirectory: workspace,
  skipGitRepoCheck: true,
});

const result = await thread.run(buildPrompt(options));
console.log(result.finalResponse);

function parseArgs(args: string[]): AgentWorkerOptions {
  const fileId = readFlag(args, "--file-id");
  const serverUrl = readFlag(args, "--server-url") ?? "http://127.0.0.1:8787";
  const workspaceRoot = readFlag(args, "--workspace-root") ?? join(homedir(), ".excalidraw-agent");
  const workspaceTemplate =
    readFlag(args, "--workspace-template") ?? new URL("../templates/codex/", import.meta.url).pathname;
  const prompt = readFlag(args, "--prompt");

  if (!fileId) {
    throw new Error("--file-id is required");
  }

  return { fileId, serverUrl, workspaceRoot, workspaceTemplate, prompt };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function buildPrompt(options: AgentWorkerOptions): string {
  return [
    `対象ファイルID: ${options.fileId}`,
    "",
    "この作業スペースの AGENTS.md を読み、Excalidraw作業では .agents/skills/excalidraw-skill/SKILL.md を使ってください。",
    "MCP tools が使えない場合は、skill の REST API mode または付属 scripts を使ってください。",
    ".excalidraw ファイルはこの作業スペース内に作成してください。",
    "",
    options.prompt ?? "現在はセットアップ確認として、利用できる作業手順を短く確認してください。",
  ].join("\n");
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
