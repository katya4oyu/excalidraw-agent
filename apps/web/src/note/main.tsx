import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  type NoteRecord,
  type NoteToParentMessage,
  type ParentToNoteMessage,
} from "@excalidraw-agent/shared";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
const fileId = params.get("fileId") ?? "";
const noteId = params.get("noteId") ?? "";

document.body.classList.add(
  "note-body",
  window.parent === window ? "note-body--standalone" : "note-body--embed",
);

ReactDOM.createRoot(document.getElementById("note-root")!).render(
  <React.StrictMode>
    <NoteApp fileId={fileId} noteId={noteId} />
  </React.StrictMode>,
);

function NoteApp({ fileId, noteId }: { fileId: string; noteId: string }) {
  const [text, setText] = useState("");

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !isParentStateMessage(event.data)) {
        return;
      }

      if (event.data.fileId !== fileId || event.data.note.noteId !== noteId) {
        return;
      }

      setText(event.data.note.text);
    };

    window.addEventListener("message", handleMessage);
    postToParent({ type: "excalidraw-agent:noteReady", fileId, noteId });

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [fileId, noteId]);

  return (
    <main className="note-card">
      <header className="note-card__header">
        <span className="note-card__avatar" aria-hidden="true">N</span>
        <span className="note-card__identity">
          <span className="note-card__name">Note</span>
          <span className="note-card__meta">canvas memo</span>
        </span>
      </header>
      <textarea
        aria-label="Note"
        className="note-card__textarea"
        disabled={!fileId || !noteId}
        placeholder="メモを書く"
        value={text}
        onChange={(event) => {
          const nextText = event.currentTarget.value;
          setText(nextText);
          postToParent({
            type: "excalidraw-agent:noteTextChanged",
            fileId,
            noteId,
            text: nextText,
          });
        }}
      />
    </main>
  );
}

function postToParent(message: NoteToParentMessage): void {
  if (!message.fileId || !message.noteId) {
    return;
  }

  window.parent.postMessage(message, window.location.origin);
}

function isParentStateMessage(value: unknown): value is ParentToNoteMessage {
  return (
    isRecord(value) &&
    value.type === "excalidraw-agent:noteState" &&
    typeof value.fileId === "string" &&
    isRecord(value.note) &&
    value.note.schemaVersion === 1 &&
    typeof value.note.noteId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
