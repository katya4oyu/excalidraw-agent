import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentStatus, CollabDocumentName, FileId, FileMetadata } from "@excalidraw-agent/shared";

const defaultDatabasePath = new URL("../data/excalidraw-agent.sqlite", import.meta.url).pathname;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path = process.env.DATABASE_URL ?? defaultDatabasePath) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  createFile(
    id: FileId,
    documentName: CollabDocumentName,
    agentStatus: AgentStatus = "starting",
  ): FileMetadata {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO files (id, document_name, created_at, updated_at, agent_status)
         VALUES ($id, $documentName, $createdAt, $updatedAt, $agentStatus)`,
      )
      .run({
        $id: id,
        $documentName: documentName,
        $createdAt: now,
        $updatedAt: now,
        $agentStatus: agentStatus,
      });

    return {
      id,
      documentName,
      createdAt: now,
      updatedAt: now,
      agentStatus,
    };
  }

  getFile(id: FileId): FileMetadata | null {
    const row = this.db
      .prepare(
        `SELECT id, document_name, created_at, updated_at, agent_status
         FROM files
         WHERE id = $id`,
      )
      .get({ $id: id }) as unknown as FileRow | null;

    return row ? toFileMetadata(row) : null;
  }

  updateAgentStatus(id: FileId, status: AgentStatus): void {
    this.db
      .prepare(
        `UPDATE files
         SET agent_status = $status, updated_at = $updatedAt
         WHERE id = $id`,
      )
      .run({
        $id: id,
        $status: status,
        $updatedAt: new Date().toISOString(),
      });
  }

  loadDocument(documentName: CollabDocumentName): Uint8Array | null {
    const row = this.db
      .prepare("SELECT state FROM yjs_documents WHERE document_name = $documentName")
      .get({ $documentName: documentName }) as { state: Uint8Array } | null;

    return row?.state ?? null;
  }

  storeDocument(documentName: CollabDocumentName, state: Uint8Array): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO yjs_documents (document_name, state, updated_at)
         VALUES ($documentName, $state, $updatedAt)
         ON CONFLICT(document_name) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run({
        $documentName: documentName,
        $state: state,
        $updatedAt: now,
      });

    this.db
      .prepare("UPDATE files SET updated_at = $updatedAt WHERE document_name = $documentName")
      .run({
        $documentName: documentName,
        $updatedAt: now,
      });
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        document_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        agent_status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS yjs_documents (
        document_name TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

interface FileRow {
  id: string;
  document_name: CollabDocumentName;
  created_at: string;
  updated_at: string;
  agent_status: AgentStatus;
}

const toFileMetadata = (row: FileRow): FileMetadata => ({
  id: row.id,
  documentName: row.document_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  agentStatus: row.agent_status,
});
