/**
 * Wire protocol between the sidecar's browser relay and its extension — the
 * role the GUI's built-in browser plays for its tab. Mirror of
 * `packages/coding-agent/src/tools/browser/relay/protocol.ts`; keep in sync.
 */

/** Minimal view of a page shared with the relay (Chrome's tab shape). */
export interface RelayTabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	discarded: boolean;
	windowId: number;
	pinned: boolean;
	groupId: number;
}

export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { op: "createTab"; url: string; active?: boolean }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	| { op: "group"; tabIds: number[]; title: string; color: string }
	| { op: "ungroup"; tabIds: number[] };

export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** Capability the relay requires before it discovers or auto-attaches tabs. */
export const DISCARDED_TABS_PROTOCOL_VERSION = 1;

export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			tabs: RelayTabSnapshot[];
			attachedTabIds: number[];
			discardedTabsProtocol: number;
			instanceId: string;
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: RelayTabSnapshot }
	| { t: "tabUpdated"; tab: RelayTabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
