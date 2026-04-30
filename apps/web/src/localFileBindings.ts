import type { FileId } from "@excalidraw-agent/shared";

const databaseName = "excalidraw-agent";
const storeName = "local-file-bindings";
const databaseVersion = 1;

export interface LocalFileBinding {
  key: string;
  fileId: FileId;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  updatedAt: string;
  fileHandle?: FileSystemFileHandle;
}

export function createLocalFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function saveLocalFileBinding(binding: LocalFileBinding): Promise<void> {
  const db = await openDatabase();
  await requestToPromise(db.transaction(storeName, "readwrite").objectStore(storeName).put(binding));
  db.close();
}

export async function findLocalFileBinding(file: File): Promise<LocalFileBinding | null> {
  const db = await openDatabase();
  const key = createLocalFileKey(file);
  const result = await requestToPromise<LocalFileBinding | undefined>(
    db.transaction(storeName, "readonly").objectStore(storeName).get(key),
  );
  db.close();
  return result ?? null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
