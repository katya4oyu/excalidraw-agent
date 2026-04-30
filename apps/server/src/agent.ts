import { fileIdFromDocumentName, type AgentStatus, type FileId } from "@excalidraw-agent/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppDatabase } from "./db";

export class AgentSupervisor {
  private readonly processes = new Map<FileId, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly db: AppDatabase,
    private readonly serverUrl: string,
  ) {}

  start(fileId: FileId, options: { prompt?: string } = {}): boolean {
    if (this.processes.has(fileId)) {
      return false;
    }

    const args = [
      "--filter",
      "@excalidraw-agent/worker",
      "dev",
      "--",
      "--file-id",
      fileId,
      "--server-url",
      this.serverUrl,
    ];
    if (options.prompt?.trim()) {
      args.push("--prompt", options.prompt.trim());
    }

    const child = spawn(
      "pnpm",
      args,
      {
        env: {
          ...process.env,
          AGENT_PARENT: "server",
        },
      },
    );

    this.processes.set(fileId, child);
    this.db.updateAgentStatus(fileId, "running");
    this.watch(fileId, child);
    return true;
  }

  isRunning(fileId: FileId): boolean {
    return this.processes.has(fileId);
  }

  markFromDocumentName(documentName: string, status: AgentStatus): void {
    const fileId = fileIdFromDocumentName(documentName);
    if (fileId) {
      this.db.updateAgentStatus(fileId, status);
    }
  }

  private watch(fileId: FileId, child: ChildProcessWithoutNullStreams): void {
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (exitCode) => {
      this.processes.delete(fileId);

      if (exitCode !== 0) {
        console.error(`Worker for ${fileId} exited with ${exitCode}`, stderr);
        this.db.updateAgentStatus(fileId, "failed");
      }
    });
  }
}
