import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type CodexAvailability = "available" | "not_logged_in" | "error";
export type CodexAuthMethod = "chatgpt" | "api_key" | "access_token" | "unknown" | null;

export interface CodexStatus {
  status: CodexAvailability;
  authMethod: CodexAuthMethod;
  message?: string;
}

export interface CodexStatusCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexStatusCommandRunner = () => Promise<CodexStatusCommandResult>;

const execFileAsync = promisify(execFile);

export async function getCodexStatus(
  runCommand: CodexStatusCommandRunner = runCodexLoginStatus,
): Promise<CodexStatus> {
  try {
    const result = await runCommand();
    const output = combineOutput(result.stdout, result.stderr);
    const authMethod = detectAuthMethod(output);

    if (isNotLoggedInOutput(output)) {
      return {
        status: "not_logged_in",
        authMethod,
        message: firstLine(output) ?? "Codex is not logged in.",
      };
    }

    if (result.exitCode === 0) {
      return {
        status: "available",
        authMethod,
        message: firstLine(output),
      };
    }

    return {
      status: "error",
      authMethod,
      message: firstLine(output) ?? `codex login status exited with ${result.exitCode}.`,
    };
  } catch (error) {
    if (isCommandMissingError(error)) {
      return {
        status: "error",
        authMethod: null,
        message: "codex command was not found.",
      };
    }

    return {
      status: "error",
      authMethod: "unknown",
      message: error instanceof Error ? error.message : "Failed to run codex login status.",
    };
  }
}

async function runCodexLoginStatus(): Promise<CodexStatusCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("codex", ["login", "status"], {
      timeout: 5_000,
      windowsHide: true,
    });

    return {
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    if (isExecFileError(error)) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
      };
    }

    throw error;
  }
}

function detectAuthMethod(output: string): CodexAuthMethod {
  const normalized = output.toLowerCase();

  if (/\bchat\s*gpt\b|\bchatgpt\b/.test(normalized)) {
    return "chatgpt";
  }

  if (/\bapi[\s_-]?key\b|\bopenai_api_key\b/.test(normalized)) {
    return "api_key";
  }

  if (/\baccess[\s_-]?token\b/.test(normalized)) {
    return "access_token";
  }

  return output.trim() ? "unknown" : null;
}

function isNotLoggedInOutput(output: string): boolean {
  return /not\s+logged\s+in|not\s+authenticated|unauthenticated|login\s+required|no\s+credentials|missing\s+credentials|please\s+log\s+in/i
    .test(output);
}

function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((text) => text.trim()).join("\n").trim();
}

function firstLine(output: string): string | undefined {
  return output.split(/\r?\n/).find((line) => line.trim())?.trim();
}

function isCommandMissingError(error: unknown): boolean {
  return isNodeJsError(error) && error.code === "ENOENT";
}

function isExecFileError(error: unknown): error is Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
} {
  return error instanceof Error && ("stdout" in error || "stderr" in error || typeof (error as { code?: unknown }).code === "number");
}

function isNodeJsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
