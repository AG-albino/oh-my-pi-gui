/** Check the actual bundled Core schema using an isolated agent profile. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RU_SCHEMA_OPTION_TEXT } from "../src/renderer/components/settings/schema-option-ru";
import { RU_GROUP_TITLES, RU_SETTINGS } from "../src/renderer/components/settings/schema-ru";
import type { SettingEntry } from "../src/shared/rpc-types";

const sidecar = process.argv[2];
if (!sidecar) throw new Error("Usage: bun scripts/check-russian-schema.ts <sidecar-path>");
const temporary = await mkdtemp(join(tmpdir(), "omp-ru-schema-"));
const child = spawn(resolve(sidecar), ["--mode", "rpc-ui"], {
	cwd: temporary,
	env: { ...process.env, PI_CODING_AGENT_DIR: temporary, PI_NO_PTY: "1", PI_NOTIFICATIONS: "off" },
	stdio: ["pipe", "pipe", "pipe"],
});
const missing = new Set<string>();
let diagnostics = "";
child.stderr.on("data", data => {
	diagnostics = (diagnostics + String(data)).slice(-2000);
});
try {
	const entries = await new Promise<SettingEntry[]>((accept, reject) => {
		const timer = setTimeout(() => reject(new Error(`Schema RPC timed out: ${diagnostics}`)), 45_000);
		const lines = createInterface({ input: child.stdout });
		const fail = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		child.once("error", fail);
		child.once("exit", code => fail(new Error(`Sidecar exited before schema response (${code}): ${diagnostics}`)));
		lines.on("line", line => {
			let frame: {
				type?: string;
				id?: string;
				success?: boolean;
				error?: string;
				data?: { entries?: SettingEntry[] };
			};
			try {
				frame = JSON.parse(line);
			} catch {
				return;
			}
			if (frame.id !== "ru-schema" || frame.type !== "response") return;
			clearTimeout(timer);
			if (!frame.success || !Array.isArray(frame.data?.entries)) reject(new Error(frame.error ?? "Invalid schema"));
			else accept(frame.data.entries);
		});
		child.stdin.write(`${JSON.stringify({ id: "ru-schema", type: "get_settings_schema" })}\n`);
	});
	for (const entry of entries) {
		const translated = RU_SETTINGS[entry.path];
		if (entry.label && !translated?.label) missing.add(`label:${entry.path}`);
		if (entry.description && !translated?.description) missing.add(`description:${entry.path}`);
		if (entry.group && !RU_GROUP_TITLES[entry.group]) missing.add(`group:${entry.group}`);
		for (const option of entry.options ?? []) {
			if (option.label && !RU_SCHEMA_OPTION_TEXT[option.label]) missing.add(`option:${option.label}`);
			if (option.description && !RU_SCHEMA_OPTION_TEXT[option.description])
				missing.add(`option:${option.description}`);
		}
	}
	if (missing.size) throw new Error(`Missing Russian schema translations:\n${[...missing].join("\n")}`);
	console.log(`Russian schema covers all ${entries.length} bundled settings and their options.`);
} finally {
	const exited = new Promise<void>(accept => child.once("close", () => accept()));
	if (child.exitCode === null) {
		child.kill();
		await exited;
	}
	await rm(temporary, { recursive: true, force: true });
}
