import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { createFile } from "../api";

export function HomePage() {
  const navigate = useNavigate();
  const createStartedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (createStartedRef.current) {
      return;
    }

    createStartedRef.current = true;
    createFile()
      .then((file) => navigate(`/files/${file.id}`, { replace: true }))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to create file");
      });
  }, [navigate]);

  return (
    <main className="state-page">
      {error ? <p className="error-text">{error}</p> : <p>Creating file...</p>}
    </main>
  );
}
