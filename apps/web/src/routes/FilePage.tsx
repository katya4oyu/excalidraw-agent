import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Excalidraw, WelcomeScreen, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  createExcalidrawAgentMetadata,
  getExcalidrawAgentMetadata,
  withExcalidrawAgentMetadata,
  type ExcalidrawAgentMetadata,
  type ExcalidrawDocumentData,
} from "@excalidraw-agent/shared";
import { getFile, importFile } from "../api";
import { useExcalidrawCollab } from "../collab/useExcalidrawCollab";
import {
  createLocalFileKey,
  findLocalFileBinding,
  saveLocalFileBinding,
} from "../localFileBindings";

type FilePickerWindow = Window & {
  showOpenFilePicker?: (options?: FilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
};

interface FilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: FilePickerAcceptType[];
}

interface SaveFilePickerOptions extends FilePickerOptions {
  suggestedName?: string;
}

interface FilePickerAcceptType {
  description: string;
  accept: Record<string, string[]>;
}

export function FilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const fallbackFileInputRef = useRef<HTMLInputElement | null>(null);
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [localFileHandle, setLocalFileHandle] = useState<FileSystemFileHandle | null>(null);
  const { api, binding, setApi, status } = useExcalidrawCollab({
    fileId: id ?? "",
    excalidrawElement: shellRef.current,
  });

  if (!id) {
    return <main className="state-page">Missing file id</main>;
  }

  const saveMetadata = (sidecarFile?: string): ExcalidrawAgentMetadata => {
    return createExcalidrawAgentMetadata(id, {
      serverBaseUrl: window.location.origin,
      sidecarFile,
    });
  };

  const handleOpenLocal = async () => {
    try {
      setLocalStatus(null);
      const picker = window as FilePickerWindow;

      if (picker.showOpenFilePicker) {
        const [handle] = await picker.showOpenFilePicker({
          multiple: false,
          types: [excalidrawFileType, sidecarFileType],
        });
        if (!handle) {
          return;
        }
        await openLocalFile(await handle.getFile(), handle);
        return;
      }

      fallbackFileInputRef.current?.click();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setLocalStatus(error instanceof Error ? error.message : "Failed to open local file");
      }
    }
  };

  const handleFallbackFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      await openLocalFile(file, null);
    }
  };

  const openLocalFile = async (file: File, fileHandle: FileSystemFileHandle | null) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const metadata = getExcalidrawAgentMetadata(parsed);

      if (metadata && !isExcalidrawDocument(parsed)) {
        await getFile(metadata.fileId);
        await rememberLocalFile(file, metadata.fileId, fileHandle);
        navigate(`/files/${metadata.fileId}`);
        return;
      }

      if (!isExcalidrawDocument(parsed)) {
        throw new Error("Excalidraw document or sidecar metadata is required");
      }

      const indexedBinding = metadata ? null : await findLocalFileBinding(file);
      const preferredFileId = metadata?.fileId ?? indexedBinding?.fileId;
      const imported = await importFile(parsed, preferredFileId);
      await rememberLocalFile(file, imported.id, fileHandle);
      setLocalFileHandle(fileHandle);
      setLocalStatus(imported.imported ? "Imported local file" : "Opened linked file");
      navigate(`/files/${imported.id}`);
    } catch (error) {
      setLocalStatus(error instanceof Error ? error.message : "Failed to open local file");
    }
  };

  const handleSaveLocal = async () => {
    if (!api) {
      return;
    }

    try {
      const fileName = localFileHandle?.name ?? `${id}.excalidraw`;
      const sidecarFile = `${withoutExcalidrawExtension(fileName)}.agent.json`;
      const document = createCurrentDocument(saveMetadata(sidecarFile));
      const blob = new Blob([JSON.stringify(document, null, 2)], {
        type: "application/vnd.excalidraw+json",
      });
      const handle = localFileHandle ?? await chooseSaveFile(fileName);

      if (handle) {
        await writeFile(handle, blob);
        const writtenFile = await handle.getFile();
        await rememberLocalFile(writtenFile, id, handle);
        setLocalFileHandle(handle);
        setLocalStatus("Saved with File ID");
        return;
      }

      downloadBlob(blob, fileName);
      setLocalStatus("Downloaded with File ID");
    } catch (error) {
      setLocalStatus(error instanceof Error ? error.message : "Failed to save local file");
    }
  };

  const handleSaveSidecar = async () => {
    try {
      const fileName = `${withoutExcalidrawExtension(localFileHandle?.name ?? id)}.agent.json`;
      const blob = new Blob([JSON.stringify(saveMetadata(), null, 2)], {
        type: "application/json",
      });
      const handle = await chooseSaveFile(fileName, [sidecarFileType]);

      if (handle) {
        await writeFile(handle, blob);
        setLocalStatus("Saved sidecar metadata");
        return;
      }

      downloadBlob(blob, fileName);
      setLocalStatus("Downloaded sidecar metadata");
    } catch (error) {
      setLocalStatus(error instanceof Error ? error.message : "Failed to save sidecar");
    }
  };

  const createCurrentDocument = (metadata: ExcalidrawAgentMetadata): ExcalidrawDocumentData => {
    const json = serializeAsJSON(
      api!.getSceneElementsIncludingDeleted(),
      api!.getAppState(),
      api!.getFiles(),
      "local",
    );
    return withExcalidrawAgentMetadata(JSON.parse(json) as Record<string, unknown>, metadata);
  };

  return (
    <main className="canvas-page">
      <div className="file-toolbar" aria-label="Local file actions">
        <button type="button" onClick={handleOpenLocal} title="Open a local .excalidraw or .agent.json file">
          Open
        </button>
        <button type="button" onClick={handleSaveLocal} disabled={!api} title="Save .excalidraw with File ID">
          Save
        </button>
        <button type="button" onClick={handleSaveSidecar} title="Save File ID sidecar metadata">
          Sidecar
        </button>
        <span className="file-toolbar__status">{localStatus ?? status}</span>
        <input
          ref={fallbackFileInputRef}
          className="file-toolbar__input"
          type="file"
          accept=".excalidraw,.json,.agent.json,application/json"
          onChange={handleFallbackFileChange}
        />
      </div>
      <div ref={shellRef} className="excalidraw-host">
        <Excalidraw
          excalidrawAPI={setApi}
          isCollaborating={Boolean(binding)}
          onPointerUpdate={binding?.onPointerUpdate}
        >
          <WelcomeScreen />
        </Excalidraw>
      </div>
    </main>
  );
}

const excalidrawFileType = {
  description: "Excalidraw file",
  accept: {
    "application/json": [".excalidraw", ".json"],
  },
};

const sidecarFileType = {
  description: "Excalidraw Agent sidecar",
  accept: {
    "application/json": [".json"],
  },
};

async function chooseSaveFile(
  suggestedName: string,
  types: FilePickerAcceptType[] = [excalidrawFileType],
): Promise<FileSystemFileHandle | null> {
  const picker = window as FilePickerWindow;
  if (!picker.showSaveFilePicker) {
    return null;
  }

  return picker.showSaveFilePicker({
    suggestedName,
    types,
  });
}

async function writeFile(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function rememberLocalFile(
  file: File,
  fileId: string,
  fileHandle: FileSystemFileHandle | null,
): Promise<void> {
  await saveLocalFileBinding({
    key: createLocalFileKey(file),
    fileId,
    fileName: file.name,
    fileSize: file.size,
    fileLastModified: file.lastModified,
    fileHandle: fileHandle ?? undefined,
    updatedAt: new Date().toISOString(),
  });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function isExcalidrawDocument(value: unknown): value is ExcalidrawDocumentData {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ExcalidrawDocumentData).elements)
  );
}

function withoutExcalidrawExtension(fileName: string): string {
  return fileName.replace(/\.excalidraw$/i, "");
}
