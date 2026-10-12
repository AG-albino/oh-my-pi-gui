import { useEffect, useState } from "react";
import type { RpcGitChanges } from "../../shared/rpc-types";
import { useTabRpc } from "../lib/tab-rpc";
import { useSessionStore } from "../stores/session";

/**
 * Number of changed files in the session's checkout, or null when unknown
 * (not a repository, not ready, or the read failed). Read when the session
 * becomes ready, whenever a run settles, and when the window regains focus —
 * never mid-run, where the serial command queue belongs to the agent.
 */
export function useWorkingTreeChangeCount(enabled: boolean): number | null {
	const rpc = useTabRpc();
	const ready = useSessionStore(state => state.status) === "ready";
	const isStreaming = useSessionStore(state => state.isStreaming);
	const sessionId = useSessionStore(state => state.sessionId);
	const [count, setCount] = useState<number | null>(null);
	const [focusPulse, setFocusPulse] = useState(0);

	useEffect(() => {
		const onFocus = () => setFocusPulse(value => value + 1);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: session switches and focus pulses re-read the checkout.
	useEffect(() => {
		if (!enabled || !ready) {
			setCount(null);
			return;
		}
		if (isStreaming) return;
		let active = true;
		void Promise.resolve()
			.then(() => rpc.getGitChanges())
			.then(response => {
				if (!active) return;
				const data = response.success ? (response.data as RpcGitChanges) : null;
				setCount(data?.isRepo ? data.files.length : null);
			})
			.catch(() => {
				if (active) setCount(null);
			});
		return () => {
			active = false;
		};
	}, [enabled, ready, isStreaming, rpc, sessionId, focusPulse]);

	return count;
}
