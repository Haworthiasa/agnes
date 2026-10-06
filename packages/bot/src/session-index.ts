import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { foldVietnamese } from "./threat-scan.ts";

export interface IndexedMessage {
	id: number;
	session: string;
	role: "user" | "assistant";
	/** Epoch milliseconds. */
	ts: number;
	text: string;
}

export interface SessionHit {
	session: string;
	/** The best matching message of the session. */
	best: IndexedMessage;
	/** The messages around it, in order, the match included. */
	window: IndexedMessage[];
}

export class QueryError extends Error {}

interface StoredLine {
	type?: string;
	id?: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

/** Words of a query, folded the way the index folds text. */
export function queryWords(query: string): string[] {
	return foldVietnamese(query)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 0);
}

/**
 * Full-text index (SQLite FTS5) over one chat's stored transcripts. Only what the user and the bot said is
 * indexed. Tool results are left out: a web page can hold hostile text, and it would crowd out the conversation.
 * Text is folded (no diacritics, `đ` as `d`), so "con meo" finds "con mèo". The index follows the JSONL files by
 * byte offset, so each search reads only what was added since the last one.
 */
export class SessionIndex {
	private readonly sessionsDir: string;
	private readonly dbPath: string;
	private db: DatabaseSync | undefined;

	constructor(sessionsDir: string, dbPath: string) {
		this.sessionsDir = sessionsDir;
		this.dbPath = dbPath;
	}

	close(): void {
		this.db?.close();
		this.db = undefined;
	}

	/** Adds the lines written to the session files since the last call. */
	sync(): void {
		if (!existsSync(this.sessionsDir)) return;
		const db = this.open();
		const files = readdirSync(this.sessionsDir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		const getFile = db.prepare("SELECT session, bytes FROM files WHERE name = ?");
		const putFile = db.prepare("INSERT OR REPLACE INTO files (name, session, bytes) VALUES (?, ?, ?)");
		const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session = ?");
		const insertMessage = db.prepare("INSERT INTO messages (session, seq, role, ts, text) VALUES (?, ?, ?, ?, ?)");
		const insertFts = db.prepare("INSERT INTO messages_fts (rowid, folded) VALUES (?, ?)");
		db.exec("BEGIN");
		try {
			for (const name of files) {
				const path = join(this.sessionsDir, name);
				const known = getFile.get(name) as { session: string; bytes: number } | undefined;
				const size = statSync(path).size;
				const start = known?.bytes ?? 0;
				if (size <= start) continue;
				const chunk = Buffer.alloc(size - start);
				const fd = openSync(path, "r");
				try {
					readSync(fd, chunk, 0, chunk.length, start);
				} finally {
					closeSync(fd);
				}
				// Only whole lines: the last line may still be mid-write.
				const lastNewline = chunk.lastIndexOf(0x0a);
				if (lastNewline < 0) continue;
				let session = known?.session ?? name.replace(/\.jsonl$/, "");
				let seq = (nextSeq.get(session) as { next: number }).next;
				for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					let entry: StoredLine;
					try {
						entry = JSON.parse(line) as StoredLine;
					} catch {
						continue;
					}
					if (entry.type === "session" && entry.id) {
						session = entry.id;
						seq = (nextSeq.get(session) as { next: number }).next;
						continue;
					}
					const role = entry.message?.role;
					if (entry.type !== "message" || (role !== "user" && role !== "assistant")) continue;
					const text = textOf(entry.message?.content).trim();
					if (!text) continue;
					const result = insertMessage.run(session, seq++, role, Date.parse(entry.timestamp ?? "") || 0, text);
					insertFts.run(result.lastInsertRowid, foldVietnamese(text));
				}
				putFile.run(name, session, start + lastNewline + 1);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * The best-matching sessions, each with the messages around its best hit. All words must match; if nothing does,
	 * any word may. A query with no letters or digits throws QueryError.
	 */
	search(query: string, options: { limit: number; windowSize: number; excludeSession?: string }): SessionHit[] {
		const words = queryWords(query);
		if (words.length === 0) throw new QueryError("The query has no words to search for.");
		this.sync();
		const db = this.open();
		const match = (joiner: string) => words.map((word) => `"${word}"`).join(joiner);
		const run = (joiner: string) =>
			db
				.prepare(
					`SELECT m.id, m.session, m.seq, m.role, m.ts, m.text FROM messages_fts
					 JOIN messages m ON m.id = messages_fts.rowid
					 WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 80`,
				)
				.all(match(joiner)) as unknown as Array<IndexedMessage & { seq: number }>;
		let rows = run(" ");
		if (rows.length === 0 && words.length > 1) rows = run(" OR ");
		const best = new Map<string, IndexedMessage & { seq: number }>();
		for (const row of rows) {
			if (row.session === options.excludeSession) continue;
			if (!best.has(row.session)) best.set(row.session, row);
		}
		return [...best.values()].slice(0, options.limit).map((row) => ({
			session: row.session,
			best: row,
			window: this.around(row.session, row.seq, options.windowSize),
		}));
	}

	/** The messages near one message id, for scrolling through a session. */
	scroll(session: string, messageId: number, windowSize: number): IndexedMessage[] {
		this.sync();
		const db = this.open();
		const row = db
			.prepare("SELECT session, seq FROM messages WHERE id = ? AND session LIKE ?")
			.get(messageId, `${session}%`) as { session: string; seq: number } | undefined;
		return row ? this.around(row.session, row.seq, windowSize) : [];
	}

	private around(session: string, seq: number, windowSize: number): IndexedMessage[] {
		return this.open()
			.prepare(
				"SELECT id, session, role, ts, text FROM messages WHERE session = ? AND seq BETWEEN ? AND ? ORDER BY seq",
			)
			.all(session, seq - windowSize, seq + windowSize) as unknown as IndexedMessage[];
	}

	private open(): DatabaseSync {
		if (this.db) return this.db;
		mkdirSync(dirname(this.dbPath), { recursive: true });
		const db = new DatabaseSync(this.dbPath);
		db.exec(`
			CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, session TEXT NOT NULL, bytes INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY, session TEXT NOT NULL, seq INTEGER NOT NULL,
				role TEXT NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS messages_session ON messages (session, seq);
			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(folded, tokenize = 'unicode61 remove_diacritics 2');
		`);
		this.db = db;
		return db;
	}
}
