import type {
  CreateFileResponse,
  ExcalidrawDocumentData,
  FileMetadata,
  ImportFileResponse,
} from "@excalidraw-agent/shared";

export async function createFile(): Promise<CreateFileResponse> {
  const response = await fetch("/api/files", { method: "POST" });

  if (!response.ok) {
    throw new Error(`Failed to create file: ${response.status}`);
  }

  return response.json() as Promise<CreateFileResponse>;
}

export async function getFile(id: string): Promise<FileMetadata> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`);

  if (!response.ok) {
    throw new Error(`Failed to load file: ${response.status}`);
  }

  return response.json() as Promise<FileMetadata>;
}

export async function importFile(
  document: ExcalidrawDocumentData,
  fileId?: string,
): Promise<ImportFileResponse> {
  const response = await fetch("/api/files/import", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ document, fileId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to import file: ${response.status}`);
  }

  return response.json() as Promise<ImportFileResponse>;
}

export async function startAgentRun(
  fileId: string,
  prompt: string,
): Promise<{ agentStatus: string; fileId: string; requestId: string }> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/agent-runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start agent run: ${response.status}`);
  }

  return response.json() as Promise<{ agentStatus: string; fileId: string; requestId: string }>;
}
