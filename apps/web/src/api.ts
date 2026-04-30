import type { CreateFileResponse, FileMetadata } from "@excalidraw-agent/shared";

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
