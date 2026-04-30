import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { FileMetadata } from "@excalidraw-agent/shared";
import { getFile } from "../api";
import { useExcalidrawCollab } from "../collab/useExcalidrawCollab";

export function FilePage() {
  const { id } = useParams();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { binding, setApi, status } = useExcalidrawCollab({
    fileId: id ?? "",
    excalidrawElement: shellRef.current,
  });

  useEffect(() => {
    if (!id) {
      return;
    }

    getFile(id)
      .then(setFile)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load file"));
  }, [id]);

  if (!id) {
    return <main className="state-page">Missing file id</main>;
  }

  return (
    <main className="canvas-page">
      <div className="topbar">
        <div>
          <span className="label">file</span>
          <span className="mono">{id.slice(0, 8)}</span>
        </div>
        <div>
          <span className="label">sync</span>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <div>
          <span className="label">agent</span>
          <span className={`status status-${file?.agentStatus ?? "idle"}`}>
            {file?.agentStatus ?? "loading"}
          </span>
        </div>
      </div>
      {error ? <div className="toast">{error}</div> : null}
      <div ref={shellRef} className="excalidraw-host">
        <Excalidraw
          excalidrawAPI={setApi}
          isCollaborating={Boolean(binding)}
          onPointerUpdate={binding?.onPointerUpdate}
        />
      </div>
    </main>
  );
}
