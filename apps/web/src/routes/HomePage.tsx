import { useState } from "react";
import { useNavigate } from "react-router";
import { createFile } from "../api";

export function HomePage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);

    try {
      const file = await createFile();
      navigate(`/files/${file.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home-shell">
      <section className="home-panel">
        <p className="eyebrow">Excalidraw Agent Workspace</p>
        <h1>Human and AI draw on the same Yjs canvas.</h1>
        <p className="home-copy">
          新規ファイルを作ると、Hono serverがSQLiteに記録し、同じroomへAI Agent workerを参加させます。
        </p>
        <button className="primary-action" type="button" onClick={handleCreate} disabled={busy}>
          {busy ? "Creating..." : "New file"}
        </button>
        {error ? <p className="error-text">{error}</p> : null}
      </section>
    </main>
  );
}
