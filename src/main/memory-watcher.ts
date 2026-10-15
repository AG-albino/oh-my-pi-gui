/**
 * Watches what omp learns outside any one window: auto-learned skills
 * (~/.omp/agent/managed-skills) and per-project memory
 * (~/.omp/agent/memories). Either can change from a background capture or
 * another omp process, so the renderer is told instead of polling. Bursts
 * (a consolidation rewrites several files) collapse into one notice.
 */
import { join, relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { IpcMemoryChange } from "../shared/ipc-types";
import { agentDir } from "./agent-paths";

const SETTLE_MS = 400;

export class MemoryWatcher {
	readonly #skillsDir: string;
	readonly #memoriesDir: string;
	#watcher: FSWatcher | null = null;
	#timer: NodeJS.Timeout | null = null;
	#skills = false;
	#memoryRoots = new Set<string>();

	onChange: ((change: IpcMemoryChange) => void) | null = null;

	constructor(root: string = agentDir()) {
		this.#skillsDir = join(root, "managed-skills");
		this.#memoriesDir = join(root, "memories");
	}

	start(): void {
		// Chokidar watches a missing folder's parent and picks it up once created.
		this.#watcher = watch([this.#skillsDir, this.#memoriesDir], { ignoreInitial: true, depth: 3 });
		this.#watcher.on("all", (_event, path) => this.#note(path));
	}

	stop(): void {
		void this.#watcher?.close();
		this.#watcher = null;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	#note(path: string): void {
		if (path === this.#skillsDir || path.startsWith(this.#skillsDir + sep)) {
			this.#skills = true;
		} else {
			const root = relative(this.#memoriesDir, path).split(sep)[0];
			if (root && !root.startsWith("..")) this.#memoryRoots.add(root);
		}
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#flush(), SETTLE_MS);
	}

	#flush(): void {
		this.#timer = null;
		const change: IpcMemoryChange = { skills: this.#skills, memoryRoots: [...this.#memoryRoots] };
		this.#skills = false;
		this.#memoryRoots.clear();
		if (change.skills || change.memoryRoots.length > 0) this.onChange?.(change);
	}
}
