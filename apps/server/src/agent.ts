import {
  fileIdFromDocumentName,
  type AgentRunQueueRequest,
  type AgentStatus,
  type AgentWorkerRequestMessage,
  type AgentWorkerResponseMessage,
  type FileId,
} from "@excalidraw-agent/shared";
import { fork, type ChildProcess } from "node:child_process";

export interface WorkerHandle {
  fileId: FileId;
  ready: boolean;
  busy: boolean;
}

interface WorkerProcessState extends WorkerHandle {
  process: ChildProcess;
  pending: AgentRunQueueRequest[];
  activeRunId?: string;
  stopping?: boolean;
}

interface AgentSupervisorDatabase {
  updateAgentStatus(id: FileId, status: AgentStatus): void;
}

export class AgentSupervisor {
  private readonly workers = new Map<FileId, WorkerProcessState>();
  private readonly workerEntry = new URL("../../worker/src/index.ts", import.meta.url).pathname;

  constructor(
    private readonly db: AgentSupervisorDatabase,
    private readonly serverUrl: string,
  ) {}

  ensureWorker(fileId: FileId): WorkerHandle {
    const existing = this.workers.get(fileId);
    if (existing) {
      return toWorkerHandle(existing);
    }

    const child = fork(
      this.workerEntry,
      [
        "--daemon",
        "--file-id",
        fileId,
        "--server-url",
        this.serverUrl,
      ],
      {
        env: {
          ...process.env,
          AGENT_PARENT: "server",
        },
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    const worker: WorkerProcessState = {
      fileId,
      ready: false,
      busy: false,
      pending: [],
      process: child,
    };

    this.workers.set(fileId, worker);
    this.db.updateAgentStatus(fileId, "starting");
    this.watch(worker);
    return toWorkerHandle(worker);
  }

  enqueueRun(fileId: FileId, request: AgentRunQueueRequest): boolean {
    const worker = this.workers.get(fileId) ?? this.ensureWorker(fileId);
    const state = this.workers.get(worker.fileId);
    if (!state || state.pending.some((pending) => pending.runId === request.runId)) {
      return false;
    }

    state.pending.push(request);
    this.flush(state);
    return true;
  }

  isWorkerReady(fileId: FileId): boolean {
    return this.workers.get(fileId)?.ready ?? false;
  }

  isRunActive(fileId: FileId): boolean {
    const worker = this.workers.get(fileId);
    return Boolean(worker?.busy || worker?.pending.length);
  }

  stopIdleWorker(fileId: FileId, reason = "idle"): boolean {
    const worker = this.workers.get(fileId);
    if (!worker || worker.busy || worker.pending.length > 0) {
      return false;
    }

    this.send(worker, { type: "shutdown", reason });
    worker.stopping = true;
    worker.process.disconnect();
    worker.process.kill();
    this.workers.delete(fileId);
    this.db.updateAgentStatus(fileId, "idle");
    return true;
  }

  markFromDocumentName(documentName: string, status: AgentStatus): void {
    const fileId = fileIdFromDocumentName(documentName);
    if (fileId) {
      this.db.updateAgentStatus(fileId, status);
    }
  }

  private watch(worker: WorkerProcessState): void {
    let stderr = "";

    worker.process.stdout?.on("data", (chunk: Buffer) => {
      console.log(`[worker:${worker.fileId}] ${chunk.toString("utf8").trimEnd()}`);
    });

    worker.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      console.error(`[worker:${worker.fileId}] ${text.trimEnd()}`);
    });

    worker.process.on("message", (message: AgentWorkerResponseMessage) => {
      this.handleMessage(worker, message);
    });

    worker.process.on("exit", (exitCode) => {
      this.workers.delete(worker.fileId);

      if (!worker.stopping && exitCode !== 0) {
        console.error(`Worker for ${worker.fileId} exited with ${exitCode}`, stderr);
        this.db.updateAgentStatus(worker.fileId, "failed");
      }
    });
  }

  private handleMessage(worker: WorkerProcessState, message: AgentWorkerResponseMessage): void {
    if (message.fileId !== worker.fileId) {
      return;
    }

    if (message.type === "ready") {
      worker.ready = true;
      this.db.updateAgentStatus(worker.fileId, worker.busy ? "running" : "idle");
      this.flush(worker);
      return;
    }

    if (message.type === "runStarted") {
      worker.busy = true;
      worker.activeRunId = message.runId;
      this.db.updateAgentStatus(worker.fileId, "running");
      return;
    }

    if (message.type === "runFinished" || message.type === "workerFailed") {
      worker.busy = false;
      worker.activeRunId = undefined;
      this.db.updateAgentStatus(worker.fileId, message.type === "workerFailed" ? "failed" : "verified");
      this.flush(worker);
    }
  }

  private flush(worker: WorkerProcessState): void {
    if (!worker.ready || worker.busy) {
      return;
    }

    const request = worker.pending.shift();
    if (!request) {
      this.db.updateAgentStatus(worker.fileId, "idle");
      return;
    }

    worker.busy = true;
    worker.activeRunId = request.runId;
    this.send(worker, { type: "runQueued", fileId: worker.fileId, request });
  }

  private send(worker: WorkerProcessState, message: AgentWorkerRequestMessage): void {
    if (worker.process.connected) {
      worker.process.send(message);
    }
  }
}

const toWorkerHandle = (worker: WorkerProcessState): WorkerHandle => ({
  busy: worker.busy,
  fileId: worker.fileId,
  ready: worker.ready,
});
