/**
 * Search over what was said in agent sessions — the user's messages and the
 * assistant's replies, never tool output — answered per message, so a hit
 * opens the session at that message.
 *
 * A derived, GUI-owned cache: an SQLite FTS5 (trigram) table of message text,
 * kept in the app's data folder and safe to delete. Session files are
 * append-only past their title slot, so a grown file is read only from where
 * the last pass stopped; a shrunk or replaced one is read again in full.
 * Reads are chunked and yield between chunks so a large session never stalls
 * the main process.
 */
import { rmSync } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTick, setTimeout as sleep } from "node:timers/promises";
import type {
	ConversationHit,
	ConversationSearchResponse,
	ConversationSearchResult,
	SessionKind,
} from "../shared/ipc-types";

const SCHEMA_VERSION = "1";
/** Bytes before the read offset that must still match for an append-only read. */
const TAIL_CHECK_BYTES = 64;
/** Bytes read per chunk; the main process yields between chunks. */
const CHUNK_BYTES = 2 * 1024 * 1024;
/** Head bytes holding the title slot and session header. */
const HEAD_BYTES = 8 * 1024;
/** Longest message body kept; longer replies match on their opening. */
const MAX_BODY_CHARS = 20_000;
/** Matching messages read per search before grouping. */
const MAX_ROWS = 400;
const HITS_PER_SESSION = 3;
const MAX_SESSIONS = 60;
/** Characters of context on each side of the first match in a snippet. */
const SNIPPET_CONTEXT = 60;
/** How long a search waits for the index to catch up before answering with what it has. */
const FRESH_WAIT_MS = 400;
/** A search within this long of the last pass reuses it instead of re-scanning. */
const FRESH_MAX_AGE_MS = 2000;
/** Snippet match delimiters; the renderer turns them into <mark>. */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

interface FileRow {
	path: string;
	signature: string;
	indexed_bytes: number;
	/** Hex of the TAIL_CHECK_BYTES before indexed_bytes. */
	tail: string;
}

interface SessionHead {
	sessionId: string | null;
	cwd: string | null;
	title: string | null;
	kind: SessionKind | null;
}

interface ParsedMessage {
	entryId: string;
	role: "user" | "assistant";
	body: string;
	timestamp: number;
}

/** Text of a persisted user/assistant message entry line; null for anything else. */
export function parseMessageLine(line: string): ParsedMessage | null {
	// Cheap rejects first: most lines are tool results and other entry kinds.
	if (!line.includes('"type":"message"')) return null;
	if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) return null;
	let row: { type?: unknown; id?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
	try {
		row = JSON.parse(line);
	} catch {
		return null;
	}
	const message = row.message;
	if (row.type !== "message" || typeof row.id !== "string" || !message) return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return null;
	let body: string;
	if (typeof message.content === "string") body = message.content;
	else if (Array.isArray(message.content)) {
		body = message.content
			.filter(
				(part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string",
			)
			.map(part => part.text)
			.join("\n");
	} else return null;
	body = body.trim();
	if (!body) return null;
	const stamp =
		typeof message.timestamp === "number"
			? message.timestamp
			: typeof row.timestamp === "string"
				? Date.parse(row.timestamp) || 0
				: 0;
	return { entryId: row.id, role, body: body.slice(0, MAX_BODY_CHARS), timestamp: stamp };
}

/** Title, id, cwd and kind from a session file's opening lines. */
export function parseSessionHead(head: string): SessionHead {
	const result: SessionHead = { sessionId: null, cwd: null, title: null, kind: null };
	for (const line of head.split("\n").slice(0, 3)) {
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type === "title" && typeof row.title === "string" && row.title.trim()) result.title = row.title.trim();
		if (row.type === "session") {
			if (typeof row.id === "string") result.sessionId = row.id;
			if (typeof row.cwd === "string") result.cwd = row.cwd;
			if (row.kind === "chat") result.kind = "chat";
			break;
		}
	}
	return result;
}

/** Whitespace-separated terms, lowercased and de-duplicated; at most eight. */
export function searchTerms(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/**
 * The stretch of `body` around its first matching term, every term wrapped in
 * MARK_OPEN/MARK_CLOSE, on one line, with ellipses where text was cut.
 */
export function buildSnippet(body: string, terms: readonly string[]): string {
	const flat = body.replace(/\s+/g, " ").trim();
	const lower = flat.toLowerCase();
	let first = -1;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at !== -1 && (first === -1 || at < first)) first = at;
	}
	const start = first <= SNIPPET_CONTEXT ? 0 : first - SNIPPET_CONTEXT;
	const end = Math.min(flat.length, Math.max(first, 0) + SNIPPET_CONTEXT * 2 + 40);
	const window = flat.slice(start, end);
	const windowLower = window.toLowerCase();
	// Mark every occurrence of every term, longest first so overlaps keep the longer one.
	const marks: Array<[number, number]> = [];
	for (const term of [...terms].sort((a, b) => b.length - a.length)) {
		let from = 0;
		for (;;) {
			const at = windowLower.indexOf(term, from);
			if (at === -1) break;
			const stop = at + term.length;
			if (!marks.some(([a, b]) => at < b && stop > a)) marks.push([at, stop]);
			from = stop;
		}
	}
	marks.sort((a, b) => a[0] - b[0]);
	let out = "";
	let cursor = 0;
	for (const [a, b] of marks) {
		out += window.slice(cursor, a) + MARK_OPEN + window.slice(a, b) + MARK_CLOSE;
		cursor = b;
	}
	out += window.slice(cursor);
	return `${start > 0 ? "…" : ""}${out}${end < flat.length ? "…" : ""}`;
}

/** FTS5 phrase for one term: quoted, inner quotes doubled. */
function phrase(term: string): string {
	return `"${term.replaceAll('"', '""')}"`;
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

/** Hex of the bytes just before `offset`, which an append must leave untouched. */
async function tailAt(handle: FileHandle, offset: number): Promise<string> {
	const start = Math.max(0, offset - TAIL_CHECK_BYTES);
	const buffer = Buffer.alloc(offset - start);
	if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
	return buffer.toString("hex");
}

export class ConversationIndex {
	readonly #db: DatabaseSync;
	readonly #sessionsDir: string;
	#refreshing: Promise<void> | null = null;
	#lastRefresh = 0;
	#progress: { done: number; total: number } | null = null;
	#closed = false;

	constructor(dbPath: string, sessionsDir: string) {
		this.#sessionsDir = sessionsDir;
		this.#db = new DatabaseSync(dbPath);
		this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		this.#db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const version = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
			| { value: string }
			| undefined;
		if (version?.value !== SCHEMA_VERSION) {
			this.#db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS entries;");
			this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
		}
		this.#db.exec(`
CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	signature TEXT NOT NULL,
	indexed_bytes INTEGER NOT NULL,
	tail TEXT NOT NULL,
	session_id TEXT,
	cwd TEXT,
	title TEXT,
	kind TEXT,
	modified INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
	body,
	path UNINDEXED,
	entry_id UNINDEXED,
	role UNINDEXED,
	ts UNINDEXED,
	tokenize = 'trigram'
);`);
	}

	close(): void {
		this.#closed = true;
		this.#db.close();
	}

	/**
	 * Search after catching up with recent writes. A long first pass is not
	 * waited out: the answer then carries `indexing` progress and the caller asks again.
	 */
	async searchFresh(query: string, scope: { cwd?: string | null } = {}): Promise<ConversationSearchResponse> {
		// A failed pass still leaves what was indexed before it searchable.
		const pass = this.refresh({ maxAgeMs: FRESH_MAX_AGE_MS }).catch(() => undefined);
		await Promise.race([pass, sleep(FRESH_WAIT_MS)]);
		return this.search(query, scope);
	}

	/** Bring the index up to date with the sessions folder; concurrent calls share one pass. */
	refresh(options: { maxAgeMs?: number } = {}): Promise<void> {
		if (this.#refreshing) return this.#refreshing;
		if (options.maxAgeMs !== undefined && Date.now() - this.#lastRefresh < options.maxAgeMs) return Promise.resolve();
		this.#refreshing = this.#refresh().finally(() => {
			this.#refreshing = null;
			this.#lastRefresh = Date.now();
			this.#progress = null;
		});
		return this.#refreshing;
	}

	search(query: string, scope: { cwd?: string | null } = {}): ConversationSearchResponse {
		const indexed = (this.#db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
		const terms = searchTerms(query);
		const status = { indexed, indexing: this.#progress ? { ...this.#progress } : null };
		if (terms.length === 0) return { results: [], ...status };

		const long = terms.filter(term => [...term].length >= 3);
		const short = terms.filter(term => [...term].length < 3);
		const where: string[] = [];
		const params: Array<string | number> = [];
		if (long.length > 0) {
			where.push("entries MATCH ?");
			params.push(long.map(phrase).join(" AND "));
		}
		for (const term of short) {
			where.push("body LIKE ? ESCAPE '\\'");
			params.push(likePattern(term));
		}
		if (scope.cwd) {
			where.push("path IN (SELECT path FROM files WHERE cwd = ?)");
			params.push(scope.cwd);
		}
		params.push(MAX_ROWS);
		const rows = this.#db
			.prepare(
				`SELECT body, path, entry_id, role, ts FROM entries WHERE ${where.join(" AND ")} ORDER BY CAST(ts AS INTEGER) DESC LIMIT ?`,
			)
			.all(...params) as Array<{ body: string; path: string; entry_id: string; role: string; ts: number | string }>;

		const byPath = new Map<string, ConversationHit[]>();
		for (const row of rows) {
			const hits = byPath.get(row.path) ?? [];
			hits.push({
				entryId: row.entry_id,
				role: row.role === "assistant" ? "assistant" : "user",
				snippet: buildSnippet(row.body, terms),
				timestamp: Number(row.ts) || 0,
			});
			byPath.set(row.path, hits);
		}
		const fileQuery = this.#db.prepare("SELECT session_id, cwd, title, kind, modified FROM files WHERE path = ?");
		const results: ConversationSearchResult[] = [];
		for (const [path, hits] of byPath) {
			if (results.length >= MAX_SESSIONS) break;
			const file = fileQuery.get(path) as
				| {
						session_id: string | null;
						cwd: string | null;
						title: string | null;
						kind: string | null;
						modified: number;
				  }
				| undefined;
			if (!file) continue;
			// Newest hits decided the order; the session reads in conversation order.
			const shown = hits.slice(0, HITS_PER_SESSION).sort((a, b) => a.timestamp - b.timestamp);
			results.push({
				path,
				sessionId: file.session_id ?? "",
				cwd: file.cwd ?? "",
				title: file.title,
				kind: file.kind === "chat" ? "chat" : undefined,
				modified: file.modified,
				hits: shown,
				more: hits.length - shown.length,
			});
		}
		return { results, ...status };
	}

	async #refresh(): Promise<void> {
		const files = await this.#scan();
		const known = new Map(
			(this.#db.prepare("SELECT path, signature, indexed_bytes, tail FROM files").all() as unknown as FileRow[]).map(
				row => [row.path, row],
			),
		);
		const removeEntries = this.#db.prepare("DELETE FROM entries WHERE path = ?");
		const removeFile = this.#db.prepare("DELETE FROM files WHERE path = ?");
		for (const path of known.keys()) {
			if (files.has(path)) continue;
			removeEntries.run(path);
			removeFile.run(path);
		}
		const stale = [...files].filter(([path, info]) => known.get(path)?.signature !== info.signature);
		if (stale.length === 0) return;
		this.#progress = { done: 0, total: stale.length };
		for (const [path, info] of stale) {
			if (this.#closed) return;
			await this.#indexFile(path, info, known.get(path));
			if (this.#progress) this.#progress.done += 1;
		}
	}

	async #scan(): Promise<Map<string, { signature: string; size: number; mtimeMs: number }>> {
		const found = new Map<string, { signature: string; size: number; mtimeMs: number }>();
		let projects: string[];
		try {
			projects = (await readdir(this.#sessionsDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.map(entry => join(this.#sessionsDir, entry.name));
		} catch {
			return found;
		}
		for (const project of projects) {
			let names: string[];
			try {
				names = (await readdir(project)).filter(name => name.endsWith(".jsonl"));
			} catch {
				continue;
			}
			for (const name of names) {
				const path = join(project, name);
				try {
					const info = await stat(path);
					found.set(path, { signature: `${info.mtimeMs}:${info.size}`, size: info.size, mtimeMs: info.mtimeMs });
				} catch {
					// Removed between listing and stat.
				}
			}
		}
		return found;
	}

	async #indexFile(
		path: string,
		info: { signature: string; size: number; mtimeMs: number },
		previous: FileRow | undefined,
	): Promise<void> {
		let handle: FileHandle;
		try {
			handle = await open(path, "r");
		} catch {
			return;
		}
		try {
			const headBuffer = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
			await handle.read(headBuffer, 0, headBuffer.length, 0);
			const head = parseSessionHead(headBuffer.toString("utf8"));
			// Appends continue from the last complete line; a file rewritten underneath starts over.
			const append =
				previous !== undefined &&
				info.size >= previous.indexed_bytes &&
				(await tailAt(handle, previous.indexed_bytes)) === previous.tail;
			let offset = append ? previous.indexed_bytes : 0;
			const parsed: ParsedMessage[] = [];
			let carry = "";
			while (offset < info.size) {
				const length = Math.min(CHUNK_BYTES, info.size - offset);
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);
				if (bytesRead === 0) break;
				const text = carry + buffer.toString("utf8", 0, bytesRead);
				const lastNewline = text.lastIndexOf("\n");
				// Only whole lines count; a trailing partial line is read again next pass.
				const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
				carry = lastNewline === -1 ? text : text.slice(lastNewline + 1);
				for (const line of complete.split("\n")) {
					const message = parseMessageLine(line);
					if (message) parsed.push(message);
				}
				offset += bytesRead;
				await nextTick();
				if (this.#closed) return;
			}
			const indexedBytes = info.size - Buffer.byteLength(carry, "utf8");
			const tail = await tailAt(handle, indexedBytes);
			this.#db.exec("BEGIN");
			try {
				if (!append) this.#db.prepare("DELETE FROM entries WHERE path = ?").run(path);
				const insert = this.#db.prepare(
					"INSERT INTO entries (body, path, entry_id, role, ts) VALUES (?, ?, ?, ?, ?)",
				);
				for (const message of parsed)
					insert.run(message.body, path, message.entryId, message.role, message.timestamp);
				this.#db
					.prepare(
						`INSERT OR REPLACE INTO files (path, signature, indexed_bytes, tail, session_id, cwd, title, kind, modified)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						path,
						info.signature,
						indexedBytes,
						tail,
						head.sessionId,
						head.cwd,
						head.title,
						head.kind,
						Math.round(info.mtimeMs),
					);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		} finally {
			await handle.close();
		}
	}
}

/**
 * Open the index at `dbPath`, starting over once if the file is unreadable —
 * it is only a cache of the session files. Null when even a fresh file fails.
 */
export function openConversationIndex(
	dbPath: string,
	sessionsDir: string,
	onError: (error: unknown) => void,
): ConversationIndex | null {
	try {
		return new ConversationIndex(dbPath, sessionsDir);
	} catch (error) {
		onError(error);
	}
	try {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
		return new ConversationIndex(dbPath, sessionsDir);
	} catch (error) {
		onError(error);
		return null;
	}
}
