/**
 * Conversation search over real session files on disk: what is searchable
 * (spoken text, never tool output), how results group, and that the index stays
 * truthful as files grow, get rewritten, or disappear between searches.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationIndex, MARK_CLOSE, MARK_OPEN } from "./conversation-index";

let root: string;
let sessionsDir: string;
let index: ConversationIndex;

function header(id: string, cwd: string, title?: string): string {
	const lines = [];
	if (title) lines.push(JSON.stringify({ type: "title", title }));
	lines.push(JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-10-01T00:00:00.000Z" }));
	return `${lines.join("\n")}\n`;
}

function message(id: string, role: "user" | "assistant" | "toolResult", text: string, timestamp: number): string {
	const content = role === "user" ? text : [{ type: "text", text }];
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role, content, timestamp } })}\n`;
}

async function session(project: string, name: string, body: string): Promise<string> {
	const dir = join(sessionsDir, project);
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, body);
	return file;
}

/** Bump mtime past the previous signature even on coarse-timestamp filesystems. */
async function touchLater(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 15);
	await promise;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-conv-index-"));
	sessionsDir = join(root, "sessions");
	index = new ConversationIndex(join(root, "index.db"), sessionsDir);
});

afterEach(async () => {
	index.close();
	await rm(root, { recursive: true, force: true });
});

describe("ConversationIndex", () => {
	it("finds what the user and assistant said, never tool output, grouped by session", async () => {
		const file = await session(
			"-proj-a-",
			"2026_a.jsonl",
			header("s1", "/proj/a", "Fix the release build") +
				message("u1", "user", "the codesign step fails on the notarize stage", 1000) +
				message("t1", "toolResult", "notarize: tool output that mentions notarize", 1500) +
				message("a1", "assistant", "Notarize needs the hardened runtime flag.", 2000),
		);
		await index.refresh();

		const response = index.search("notarize");
		expect(response.indexed).toBe(1);
		expect(response.results).toHaveLength(1);
		const [result] = response.results;
		expect(result).toMatchObject({
			path: file,
			sessionId: "s1",
			cwd: "/proj/a",
			title: "Fix the release build",
			more: 0,
		});
		// Conversation order inside the session, tool output excluded.
		expect(result?.hits.map(hit => [hit.entryId, hit.role])).toEqual([
			["u1", "user"],
			["a1", "assistant"],
		]);
		expect(result?.hits[1]?.snippet).toBe(`${MARK_OPEN}Notarize${MARK_CLOSE} needs the hardened runtime flag.`);
	});

	it("requires every term and matches short and CJK terms", async () => {
		await session(
			"-proj-a-",
			"x.jsonl",
			header("s1", "/proj/a") +
				message("u1", "user", "把缓存清掉以后 UI 恢复了", 1000) +
				message("u2", "user", "the cache layer is fine", 2000),
		);
		await index.refresh();

		expect(index.search("缓存").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(index.search("ui 缓存").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(index.search("cache 缓存").results).toEqual([]);
	});

	it("limits a search to one project", async () => {
		await session("-proj-a-", "a.jsonl", header("sa", "/proj/a") + message("u1", "user", "deploy the worker", 1000));
		await session("-proj-b-", "b.jsonl", header("sb", "/proj/b") + message("u1", "user", "deploy the site", 2000));
		await index.refresh();

		expect(index.search("deploy").results.map(result => result.sessionId)).toEqual(["sb", "sa"]);
		expect(index.search("deploy", { cwd: "/proj/a" }).results.map(result => result.sessionId)).toEqual(["sa"]);
	});

	it("picks up appended messages once, and a half-written line only when complete", async () => {
		const file = await session(
			"-proj-a-",
			"a.jsonl",
			header("s1", "/proj/a") + message("u1", "user", "alpha topic", 1000),
		);
		await index.refresh();

		const next = message("a1", "assistant", "alpha answer with bravo", 2000);
		await touchLater();
		await appendFile(file, next.slice(0, 40));
		await index.refresh();
		expect(index.search("bravo").results).toEqual([]);

		await touchLater();
		await appendFile(file, next.slice(40));
		await index.refresh();
		expect(index.search("bravo").results[0]?.hits.map(hit => hit.entryId)).toEqual(["a1"]);
		// The first message was not indexed a second time by the append pass.
		expect(index.search("alpha").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1", "a1"]);
	});

	it("forgets text that a rewrite or removal took away", async () => {
		const file = await session(
			"-proj-a-",
			"a.jsonl",
			header("s1", "/proj/a") + message("u1", "user", "original wording here", 1000),
		);
		const other = await session(
			"-proj-a-",
			"b.jsonl",
			header("s2", "/proj/a") + message("u1", "user", "gone soon", 1000),
		);
		await index.refresh();

		// Same length or longer, but the earlier bytes changed: not an append.
		await touchLater();
		await writeFile(file, header("s1", "/proj/a") + message("u1", "user", "replaced wording here, longer", 1000));
		await rm(other);
		await index.refresh();

		expect(index.search("original").results).toEqual([]);
		expect(index.search("replaced").results[0]?.hits).toHaveLength(1);
		expect(index.search("gone").results).toEqual([]);
		expect(index.search("wording").indexed).toBe(1);
	});

	it("keeps its index across restarts", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "persistent memo", 1000));
		await index.refresh();
		index.close();

		index = new ConversationIndex(join(root, "index.db"), sessionsDir);
		expect(index.search("memo").results.map(result => result.sessionId)).toEqual(["s1"]);
	});
});
