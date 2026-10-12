import {
	BarChart3,
	Bot,
	BriefcaseBusiness,
	ChevronRight,
	Code2,
	Coins,
	Command,
	ExternalLink,
	Folder,
	GitBranchPlus,
	GitPullRequest,
	Keyboard,
	type LucideIcon,
	MessageCircle,
	MessageSquarePlus,
	MessageSquareWarning,
	MoreHorizontal,
	Palette,
	Pencil,
	Pin,
	PinOff,
	Plug,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Sparkles,
	SquarePen,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { useSessionList } from "../../hooks/use-session-list";
import { dropSessionNow } from "../../hooks/use-session-switch";
import { basename, cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { compileKeymap, KEYMAP_ACTIONS, onEscape } from "../../lib/keymap";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useTabRpc } from "../../lib/tab-rpc";
import { tabSignalPresentation } from "../../lib/tab-signal";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button } from "../common";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common/ContextMenu";
import { LangSwitcher } from "../common/LangSwitcher";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";

const STATUS_COLOR: Record<SessionInfo["status"], string> = {
	complete: "var(--omp-success)",
	interrupted: "var(--omp-warning)",
	aborted: "var(--omp-warning)",
	error: "var(--omp-error)",
	pending: "var(--omp-dim)",
	unknown: "var(--omp-dim)",
};

const STATUS_LABEL_KEY: Record<SessionInfo["status"], string> = {
	complete: "sidebar.status.complete",
	interrupted: "sidebar.status.interrupted",
	aborted: "sidebar.status.aborted",
	error: "sidebar.status.error",
	pending: "sidebar.status.pending",
	unknown: "sidebar.status.unknown",
};

interface WorkspaceGroup {
	cwd: string;
	name: string;
	sessions: SessionInfo[];
}

/** A delete the row or context menu queued, awaiting the confirmation dialog. */
type PendingDelete = { kind: "session"; session: SessionInfo } | { kind: "group"; group: WorkspaceGroup };

type SidebarMode = "code" | "work";

function modifiedAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.modified);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function SidebarRowTitle({ className, title }: { className?: string; title: string }) {
	return (
		<span className={cx("omp-sidebar-title min-w-0 flex-1 truncate", className)} title={title}>
			{title}
		</span>
	);
}

/**
 * Left rail with two agent-capable lanes plus global tool-free chats. Code
 * groups project sessions by workspace; Work uses one GUI-owned default
 * workspace with no folder picker. The main action creates an agent, while the
 * adjacent quick-chat action creates a chat.
 */
export function Sidebar() {
	const tabRpc = useTabRpc();
	const t = useT();
	const keymapOverrides = useUiStore(state => state.keymapOverrides);
	// The chords bound to each action, as the user configured them.
	const actionChords = useMemo(() => {
		const chords = new Map<string, string[]>();
		for (const [chord, action] of compileKeymap(KEYMAP_ACTIONS, keymapOverrides)) {
			chords.set(action, [...(chords.get(action) ?? []), chord]);
		}
		return chords;
	}, [keymapOverrides]);
	const paletteShortcut = (actionChords.get("palette") ?? []).join(" / ");
	const [mode, setMode] = useState<SidebarMode>("code");
	const [defaultWorkspace, setDefaultWorkspace] = useState<string | null>(null);
	const switchPendingTo = useSessionStore(s => s.switchPending?.toId ?? null);
	// Resizable left rail (mirrors PanelContainer's right-rail drag, but the
	// handle sits on the right edge and dragging right grows the sidebar).
	const SIDEBAR_MIN = 180;
	const SIDEBAR_MAX = 420;
	const [sidebarWidth, setSidebarWidth] = useState(236);
	const sidebarWidthRef = useRef(236);
	// Layout widths persist like every other chrome pref; restored on mount.
	useEffect(() => {
		void window.omp.prefs
			.get("sidebarWidth")
			.then(value => {
				if (typeof value !== "number" || !Number.isFinite(value)) return;
				const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value));
				sidebarWidthRef.current = clamped;
				setSidebarWidth(clamped);
			})
			.catch(() => {});
	}, []);
	const sidebarDragging = useRef(false);
	const startSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		sidebarDragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);
	const onSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!sidebarDragging.current) return;
		// Sidebar is left-anchored: dragging right grows it.
		const host = e.currentTarget.parentElement;
		if (!host) return;
		const hostRect = host.getBoundingClientRect();
		const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - hostRect.left));
		sidebarWidthRef.current = clamped;
		setSidebarWidth(clamped);
	}, []);
	const endSidebarDrag = useCallback(() => {
		sidebarDragging.current = false;
		void window.omp.prefs.set("sidebarWidth", sidebarWidthRef.current).catch(() => {});
	}, []);
	const [deleting, setDeleting] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	// Deleting a session hard-deletes its transcript file, so the row and menu
	// clicks only queue it: the dialog names the target and states the
	// consequence before anything is removed.
	const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
	const [renamingSessionPath, setRenamingSessionPath] = useState<string | null>(null);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	// Mode selector, workspace group context menu, session row context menu.
	const [moreMenu, setMoreMenu] = useState<ContextMenuAnchor | null>(null);
	const [groupMenu, setGroupMenu] = useState<{ anchor: ContextMenuAnchor; group: WorkspaceGroup } | null>(null);
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SessionInfo } | null>(null);
	// Workspace display alias rename (group header inline input).
	const [renamingGroupCwd, setRenamingGroupCwd] = useState<string | null>(null);
	const [groupRenameDraft, setGroupRenameDraft] = useState("");
	const groupRenameRef = useRef<HTMLInputElement>(null);
	const openTab = useTabsStore(s => s.openTab);
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const activeTab = tabs.find(tab => tab.id === activeTabId);
	const activeTabKind = activeTab?.kind;
	const pinnedGroups = useSidebarPrefs(s => s.pinnedGroups);
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const workspaceLastUsed = useSidebarPrefs(s => s.workspaceLastUsed);
	const sessionLastUsed = useSidebarPrefs(s => s.sessionLastUsed);
	const touchSession = useSidebarPrefs(s => s.touchSession);
	const renameRef = useRef<HTMLInputElement>(null);
	const { sessions, isLoading, error: listError, refresh, deleteSession, renameSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	// Sidebar signal-light state for the ATTACHED session: a blocking
	// confirmation (plan approval / ask / permission) overrides the running
	// signal — it needs the user, not just time.
	const awaitingConfirmation = useAwaitingConfirmation();
	const openThemePicker = useUiStore(s => s.openThemePicker);
	const openSessionPicker = useUiStore(s => s.openSessionPicker);

	useEffect(() => {
		void window.omp.sidecar
			.defaultWorkspace()
			.then(workspace => {
				setDefaultWorkspace(workspace);
				const tabState = useTabsStore.getState();
				const activeKind = tabState.tabs.find(tab => tab.id === tabState.activeTabId)?.kind;
				if (activeKind !== "chat" && useSessionStore.getState().cwd === workspace) setMode("work");
			})
			.catch(() => {});
	}, []);

	// Opening a session from the global search keeps the lane label honest.
	useEffect(() => {
		if (!defaultWorkspace || !cwd) return;
		setMode(activeTabKind === "chat" ? "code" : cwd === defaultWorkspace ? "work" : "code");
	}, [activeTabKind, cwd, defaultWorkspace]);

	const recencyForSession = useCallback(
		(session: SessionInfo) => sessionLastUsed[session.path] ?? modifiedAt(session),
		[sessionLastUsed],
	);
	const agentSessions = useMemo(() => sessions.filter(session => session.kind !== "chat"), [sessions]);
	const codeSessions = useMemo(
		() => agentSessions.filter(session => !defaultWorkspace || session.cwd !== defaultWorkspace),
		[agentSessions, defaultWorkspace],
	);
	const workSessions = useMemo(
		() =>
			agentSessions
				.filter(session => defaultWorkspace !== null && session.cwd === defaultWorkspace)
				.toSorted((a, b) => {
					const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
					const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
					if (aPinned !== bPinned) return aPinned - bPinned;
					return recencyForSession(b) - recencyForSession(a);
				}),
		[agentSessions, defaultWorkspace, pinnedSessions, recencyForSession],
	);
	const chatSessions = useMemo(
		() =>
			sessions
				.filter(session => session.kind === "chat")
				.toSorted((a, b) => {
					const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
					const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
					if (aPinned !== bPinned) return aPinned - bPinned;
					return recencyForSession(b) - recencyForSession(a);
				}),
		[sessions, pinnedSessions, recencyForSession],
	);

	// Code sessions stay grouped by project. Pins remain a priority partition,
	// with MRU inside it.
	const groups = useMemo<WorkspaceGroup[]>(() => {
		const byCwd = new Map<string, SessionInfo[]>();
		for (const session of codeSessions) {
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		const result: WorkspaceGroup[] = [...byCwd.entries()].map(([groupCwd, groupSessions]) => ({
			cwd: groupCwd,
			name: groupAliases[groupCwd] ?? (basename(groupCwd) || groupCwd),
			sessions: [...groupSessions].sort((a, b) => {
				const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
				const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
				if (aPinned !== bPinned) return aPinned - bPinned;
				return recencyForSession(b) - recencyForSession(a);
			}),
		}));
		result.sort((a, b) => {
			const aPinned = pinnedGroups.includes(a.cwd) ? 0 : 1;
			const bPinned = pinnedGroups.includes(b.cwd) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			const aRecency = Math.max(workspaceLastUsed[a.cwd] ?? 0, ...a.sessions.map(recencyForSession));
			const bRecency = Math.max(workspaceLastUsed[b.cwd] ?? 0, ...b.sessions.map(recencyForSession));
			return bRecency - aRecency;
		});
		return result;
	}, [codeSessions, groupAliases, pinnedGroups, pinnedSessions, recencyForSession, workspaceLastUsed]);
	const totalCount = mode === "work" ? workSessions.length : codeSessions.length + chatSessions.length;
	const visibleGroups = mode === "code" ? groups : [];
	const chatsCollapsed = collapsed.__chats__ ?? false;

	const isCollapsed = (groupCwd: string) => {
		if (groupCwd in collapsed) return collapsed[groupCwd];
		// Default: current workspace expanded, others collapsed (Codex-style).
		return groupCwd !== cwd;
	};
	const toggleGroup = (groupCwd: string) => {
		setCollapsed(prev => ({ ...prev, [groupCwd]: !isCollapsed(groupCwd) }));
	};
	const tabForSession = (session: SessionInfo) =>
		tabs.find(tab => tab.sessionId === session.id) ?? (session.id === sessionId ? activeTab : undefined);
	const sessionTabSignal = (session: SessionInfo) => {
		const tab = tabForSession(session);
		return tab ? tabSignalPresentation(tab, session.id === sessionId && (isStreaming || isCompacting)) : null;
	};
	const isSessionBusy = (session: SessionInfo) => {
		if (session.id === sessionId && awaitingConfirmation) return true;
		const signal = sessionTabSignal(session);
		if (signal) return signal.active;
		if (session.id === sessionId && (isStreaming || isCompacting)) return true;
		return session.status === "pending";
	};

	const openSession = (session: SessionInfo) => {
		if (session.id === sessionId) return;
		void openTab({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
	};
	const startNew = () => {
		if (mode === "work") {
			void openTab({ kind: "agent", work: true });
			return;
		}
		setWorkspaceOpen(true);
	};

	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "error", message: t("sidebar.newWindowFailed") });
			return;
		}
		touchSession(session.path, session.kind === "chat" ? undefined : session.cwd);
	};

	const startRename = (session: SessionInfo) => {
		setRenameDraft(session.title || session.firstMessage || "");
		setRenamingSessionPath(session.path);
		requestAnimationFrame(() => renameRef.current?.select());
	};
	const commitRename = (session: SessionInfo, value = renameDraft) => {
		setRenamingSessionPath(null);
		const name = value.trim();
		if (!name || name === session.title) return;
		void renameSession(session.path, name)
			.then(() => {
				if (session.id === sessionId) useSessionStore.setState({ sessionName: name });
			})
			.catch(error => toast({ variant: "error", title: t("sidebar.renameFailed"), message: String(error) }));
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		if (isSessionBusy(session)) {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		try {
			if (session.id === sessionId) {
				await dropSessionNow();
			} else {
				await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
		} finally {
			setDeleting(false);
		}
	};

	const confirmDeleteGroup = async (group: WorkspaceGroup) => {
		if (group.sessions.some(isSessionBusy)) {
			toast({ variant: "warning", message: t("sidebar.deleteGroupStreaming") });
			setPendingDelete(null);
			return;
		}
		setDeleting(true);
		try {
			// Delete every session file in this workspace, then dismiss the group.
			for (const session of group.sessions) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				if (session.id === sessionId) await dropSessionNow();
				else await deleteSession(session.path);
			}
			setPendingDelete(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
		} finally {
			setDeleting(false);
		}
	};

	const rowActionButton =
		"omp-sidebar-action flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";

	const renderSessionRow = (session: SessionInfo) => {
		const active = session.id === sessionId;
		const tabSignal = sessionTabSignal(session);
		const waiting = active && awaitingConfirmation;
		const externalRunning = tabSignal === null && isSessionBusy(session);
		const signalActive = waiting || tabSignal?.active === true || externalRunning;
		const signalLabel = waiting
			? t("sidebar.signal.waiting")
			: tabSignal
				? t(tabSignal.labelKey)
				: externalRunning
					? t("sidebar.signal.running")
					: t(STATUS_LABEL_KEY[session.status]);
		const signalColor = waiting
			? "var(--omp-warning)"
			: (tabSignal?.color ?? (externalRunning ? "var(--omp-accent)" : STATUS_COLOR[session.status]));
		const title = sessionDisplayTitle(session, t("sidebar.untitled"));
		const hasActions = !signalActive || !active;
		const renaming = renamingSessionPath === session.path;
		const pinned = pinnedSessions.includes(session.path);
		const recency = recencyForSession(session);
		return (
			<div
				key={session.path}
				role="button"
				tabIndex={0}
				onClick={() => void openSession(session)}
				onContextMenu={event => setSessionMenu({ anchor: anchorFromEvent(event), session })}
				onKeyDown={event => {
					// Only the row itself: Enter inside a nested control (rename
					// input, action buttons) must not also switch the session.
					if (event.key === "Enter" && event.target === event.currentTarget) void openSession(session);
				}}
				data-active={active}
				data-switch-pending={switchPendingTo === session.id || undefined}
				data-has-actions={hasActions}
				data-actions-open={renaming}
				data-session-kind={session.kind ?? "agent"}
				className={cx(
					"omp-sidebar-session-row omp-color-fade group flex h-[30px] cursor-pointer items-center rounded-lg px-2",
					active ? "bg-[var(--omp-selected-bg)]" : "hover:bg-[var(--omp-sidebar-item-hover)]",
				)}
			>
				{/* The status slot lines titles up under the group icon; idle rows leave it empty. */}
				<span aria-hidden="true" data-sidebar-session-icon className="mr-2 flex w-4 shrink-0 justify-center">
					<span
						role="img"
						aria-label={signalLabel}
						title={signalLabel}
						className={cx("omp-signal-light", signalActive && "omp-signal-light--active")}
						data-idle={
							// Past sessions that simply finished carry no signal; unread
							// completions (an open tab) and anything live or failed do.
							(!signalActive &&
								(signalColor === "var(--omp-dim)" || (tabSignal === null && session.status === "complete"))) ||
							undefined
						}
						style={{ color: signalColor }}
					/>
				</span>
				{pinned && (
					<Pin size={11} className="mr-1.5 shrink-0 text-[var(--omp-dim)]" aria-label={t("sidebar.pinned")} />
				)}
				{renaming ? (
					<input
						ref={renameRef}
						value={renameDraft}
						onChange={event => setRenameDraft(event.target.value)}
						onBlur={event => commitRename(session, event.currentTarget.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") commitRename(session, event.currentTarget.value);
							onEscape(event, () => setRenamingSessionPath(null));
						}}
						onClick={event => event.stopPropagation()}
						className="min-w-0 flex-1 rounded-md border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1.5 py-0.5 text-omp-md text-[var(--omp-text)] outline-none"
					/>
				) : (
					<SidebarRowTitle
						className={cx(
							"text-omp-md leading-5",
							active ? "text-[var(--omp-text)]" : "text-[var(--omp-text-secondary)]",
						)}
						title={title}
					/>
				)}
				{!renaming && recency > 0 && (
					<span className="omp-sidebar-time ml-2 shrink-0 text-omp-xs tabular-nums text-[var(--omp-dim)]">
						{formatTimeAgo(new Date(recency).toISOString(), { compact: true })}
					</span>
				)}
				<span
					className="omp-sidebar-session-actions flex shrink-0 items-center justify-end gap-0.5"
					onClick={event => event.stopPropagation()}
				>
					{!signalActive && !renaming ? (
						<button
							type="button"
							title={t("sidebar.rename")}
							aria-label={t("sidebar.rename")}
							onClick={() => startRename(session)}
							className={rowActionButton}
						>
							<Pencil size={12} />
						</button>
					) : !active ? (
						<button
							type="button"
							title={t("sidebar.menu.openNewTab")}
							aria-label={t("sidebar.menu.openNewTab")}
							onClick={() => void openSession(session)}
							className={rowActionButton}
						>
							<Plus size={12} />
						</button>
					) : null}
					{!signalActive && (
						<button
							className={cx(
								rowActionButton,
								"hover:!bg-[var(--omp-tool-error-bg)] hover:!text-[var(--omp-error)]",
							)}
							onClick={() => setPendingDelete({ kind: "session", session })}
							title={t("sidebar.delete")}
							type="button"
							aria-label={t("sidebar.delete")}
						>
							<Trash2 size={12} />
						</button>
					)}
				</span>
			</div>
		);
	};

	/** One collapsible group header: icon (chevron on hover), name, count, hover actions. */
	const renderGroupHeader = ({
		id,
		name,
		count,
		icon: Icon,
		collapsedState,
		onToggle,
		pinned,
		actions,
		renameInput,
		onContextMenu,
		current,
	}: {
		id: string;
		name: string;
		count: number;
		icon: LucideIcon;
		collapsedState: boolean;
		onToggle: () => void;
		pinned?: boolean;
		actions?: ReactNode;
		renameInput?: ReactNode;
		onContextMenu?: (event: ReactMouseEvent) => void;
		current?: boolean;
	}) => (
		<div
			data-workspace-group={id === "__chats__" ? undefined : id}
			data-actions-open={renameInput ? true : undefined}
			onContextMenu={onContextMenu}
			className={cx(
				"omp-sidebar-workspace-row omp-color-fade group/header flex h-[30px] w-full items-center rounded-lg px-2 text-omp-md",
				current ? "text-[var(--omp-text)]" : "text-[var(--omp-muted)] hover:text-[var(--omp-text)]",
				"hover:bg-[var(--omp-sidebar-item-hover)]",
			)}
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={!collapsedState}
				aria-label={renameInput ? name : undefined}
				className="flex min-w-0 flex-1 items-center text-left"
			>
				<span className="omp-sidebar-group-icon relative mr-2 flex size-4 shrink-0 items-center justify-center">
					<Icon
						aria-hidden="true"
						data-sidebar-workspace-icon={id === "__chats__" ? undefined : true}
						size={15}
						strokeWidth={1.75}
					/>
					<ChevronRight
						aria-hidden="true"
						size={13}
						className={cx("omp-disclosure-chevron absolute", !collapsedState && "rotate-90")}
					/>
				</span>
				{pinned && (
					<Pin size={11} className="mr-1.5 shrink-0 text-[var(--omp-dim)]" aria-label={t("sidebar.pinned")} />
				)}
				{renameInput ?? <SidebarRowTitle className="text-left font-medium" title={name} />}
			</button>
			{!renameInput && (
				<span className="omp-sidebar-group-count ml-2 shrink-0 text-omp-xs tabular-nums text-[var(--omp-dim)]">
					{count}
				</span>
			)}
			{actions && (
				<span
					className="omp-sidebar-workspace-actions flex shrink-0 items-center justify-end gap-0.5"
					onClick={event => event.stopPropagation()}
				>
					{actions}
				</span>
			)}
		</div>
	);

	interface NavigationItem {
		id: string;
		icon: LucideIcon;
		label: string;
		title?: string;
		shortcut?: string;
		onClick: () => void;
	}
	// Session work stays one click away; app-wide tools live in the More menu
	// and remain reachable from the Command Center.
	const primaryNavigation: NavigationItem[] = [
		{
			id: "commands",
			icon: Command,
			label: t("titlebar.commands"),
			shortcut: actionChords.get("palette")?.[0],
			title: t("titlebar.commandsHint", { shortcut: paletteShortcut }),
			onClick: () => useUiStore.getState().openCommandPalette(),
		},
		{
			id: "agents",
			icon: Bot,
			label: t("titlebar.agentHub"),
			shortcut: actionChords.get("agents.hub")?.[0],
			onClick: () => useUiStore.getState().openAgentHub(),
		},
		{
			id: "pull-requests",
			icon: GitPullRequest,
			label: t("titlebar.prCenter"),
			shortcut: actionChords.get("pr.center")?.[0],
			onClick: () => useUiStore.getState().openPrCenter(),
		},
	];
	const secondaryNavigation: NavigationItem[] = [
		{
			id: "capabilities",
			icon: Sparkles,
			label: t("sidebar.navigation.capabilities"),
			title: t("settings.capabilities.description"),
			onClick: () => useUiStore.getState().openSettings("capabilities"),
		},
		{
			id: "providers",
			icon: Plug,
			label: t("titlebar.providers"),
			onClick: () => useUiStore.getState().openProviders(),
		},
		{ id: "usage", icon: Coins, label: t("titlebar.usage"), onClick: () => useUiStore.getState().openUsage() },
		{
			id: "stats",
			icon: BarChart3,
			label: t("titlebar.stats"),
			onClick: () => useUiStore.getState().openStatsDashboard(),
		},
		{
			id: "hotkeys",
			icon: Keyboard,
			label: t("titlebar.hotkeys"),
			shortcut: actionChords.get("hotkeys")?.[0],
			onClick: () => useUiStore.getState().openHotkeys(),
		},
		{
			id: "feedback",
			icon: MessageSquareWarning,
			label: t("titlebar.feedback"),
			title: t("titlebar.feedbackHint"),
			onClick: () => useUiStore.getState().openFeedback(),
		},
	];
	const navigationRow =
		"omp-pressable group/nav flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-omp-md text-[var(--omp-text-secondary)] hover:bg-[var(--omp-sidebar-item-hover)] hover:text-[var(--omp-text)]";
	const renderNavigationItem = (item: NavigationItem) => {
		const Icon = item.icon;
		return (
			<button
				key={item.id}
				type="button"
				onClick={item.onClick}
				data-command-center-entry={item.id === "commands" ? true : undefined}
				title={item.title}
				className={navigationRow}
			>
				<Icon aria-hidden="true" className="shrink-0 text-[var(--omp-muted)]" size={16} strokeWidth={1.75} />
				<span className="min-w-0 flex-1 truncate">{item.label}</span>
				{item.shortcut && (
					<span className="shrink-0 text-omp-xs tracking-wide text-[var(--omp-dim)] opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
						{item.shortcut}
					</span>
				)}
			</button>
		);
	};

	const utilityButton =
		"omp-pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";
	const newShortcut = actionChords.get("tab.new")?.[0];

	return (
		<>
			<aside
				className="omp-session-sidebar relative flex h-full shrink-0 flex-col border-r border-[var(--omp-border-muted)] bg-[var(--omp-sidebar-bg)]"
				style={{ width: sidebarWidth }}
			>
				{/* Header: the lane switch and session search. */}
				<div className="drag-region flex h-12 shrink-0 items-center gap-1 px-2.5">
					<div role="group" aria-label={t("sidebar.mode.aria")} className="omp-segmented no-drag">
						{(["code", "work"] as const).map(value => {
							const Icon = value === "code" ? Code2 : BriefcaseBusiness;
							return (
								<button
									key={value}
									type="button"
									aria-pressed={mode === value}
									title={t(value === "code" ? "sidebar.mode.codeDescription" : "sidebar.mode.workDescription")}
									onClick={() => setMode(value)}
									className="flex h-6 items-center gap-1.5 px-2.5 text-omp-sm font-medium"
								>
									<Icon aria-hidden="true" size={13} />
									{t(`sidebar.mode.${value}`)}
								</button>
							);
						})}
					</div>
					<div className="flex-1" />
					<button
						type="button"
						onClick={openSessionPicker}
						title={t("sidebar.search")}
						aria-label={t("sidebar.search")}
						className="no-drag omp-pressable flex h-7 w-7 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
					>
						<Search size={15} />
					</button>
				</div>

				{/* Primary action + navigation. */}
				<div className="shrink-0 px-2 pt-1 pb-3" data-sidebar-navigation>
					<div className="mb-1 flex items-center gap-1">
						<button
							type="button"
							data-sidebar-new-agent
							onClick={startNew}
							className="omp-pressable group/nav flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left text-omp-md font-medium text-[var(--omp-text)] hover:bg-[var(--omp-sidebar-item-hover)]"
						>
							<SquarePen aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" />
							<span className="min-w-0 flex-1 truncate">
								{mode === "code" ? t("sidebar.newCode") : t("sidebar.newWork")}
							</span>
							{newShortcut && (
								<span className="shrink-0 text-omp-xs font-normal tracking-wide text-[var(--omp-dim)] opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100">
									{newShortcut}
								</span>
							)}
						</button>
						{mode === "code" && (
							<button
								type="button"
								data-sidebar-new-chat
								onClick={() => void openTab({ kind: "chat" })}
								title={t("sidebar.quickChat")}
								aria-label={t("sidebar.quickChat")}
								className="omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-sidebar-item-hover)] hover:text-[var(--omp-text)]"
							>
								<MessageSquarePlus size={16} strokeWidth={1.75} />
							</button>
						)}
					</div>
					<div className="space-y-px">{primaryNavigation.map(renderNavigationItem)}</div>
					<button
						type="button"
						aria-haspopup="menu"
						aria-expanded={moreMenu !== null}
						aria-label={t("sidebar.navigation.expand")}
						title={t("sidebar.navigation.expand")}
						onClick={event => {
							const rect = event.currentTarget.getBoundingClientRect();
							setMoreMenu({
								x: Number.isFinite(rect.left) ? rect.left : 8,
								y: (Number.isFinite(rect.bottom) ? rect.bottom : 200) + 4,
							});
						}}
						className={cx(
							navigationRow,
							"mt-px",
							moreMenu && "bg-[var(--omp-sidebar-item-hover)] text-[var(--omp-text)]",
						)}
					>
						<MoreHorizontal
							aria-hidden="true"
							className="shrink-0 text-[var(--omp-muted)]"
							size={16}
							strokeWidth={1.75}
						/>
						<span className="min-w-0 flex-1 truncate">{t("sidebar.navigation.more")}</span>
					</button>
				</div>

				<div className="flex h-7 shrink-0 items-center px-4">
					<span className="text-omp-xs font-medium text-[var(--omp-dim)]">{t("sidebar.recent")}</span>
				</div>

				<div className="omp-sidebar-list min-h-0 flex-1 overflow-y-auto px-2 pb-3 [overflow-anchor:none]">
					{listError && sessions.length > 0 && (
						<p role="alert" className="mx-2 mb-1 break-words text-omp-xs text-[var(--omp-error)]">
							{t("sidebar.stale")}: {listError}
						</p>
					)}
					{isLoading && sessions.length === 0 && (
						<div className="space-y-1 px-2 py-1" aria-label={t("sidebar.loading")}>
							{[72, 56, 64].map(width => (
								<div key={width} className="omp-skeleton h-[22px] rounded-md" style={{ width: `${width}%` }} />
							))}
						</div>
					)}
					{listError && sessions.length === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center gap-2 px-4 py-6 text-center">
							<div className="text-omp-md font-medium text-[var(--omp-error)]">{t("sidebar.loadFailed")}</div>
							<div className="break-words text-omp-xs text-[var(--omp-muted)]">{listError}</div>
							<Button icon={<RefreshCw size={12} />} onClick={() => refresh(true)} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						</div>
					)}
					{!isLoading && !listError && totalCount === 0 && (
						<div className="omp-sidebar-empty px-2 py-2 text-omp-sm leading-relaxed text-[var(--omp-dim)]">
							{mode === "code" ? t("sidebar.emptyCode") : t("sidebar.emptyWork")}
						</div>
					)}
					{mode === "work" && workSessions.length > 0 && (
						<div className="space-y-px" data-work-section>
							{workSessions.map(session => renderSessionRow(session))}
						</div>
					)}
					{visibleGroups.map(group => {
						const groupCollapsed = isCollapsed(group.cwd);
						const renaming = renamingGroupCwd === group.cwd;
						return (
							<div key={group.cwd} className="mb-1">
								{renderGroupHeader({
									id: group.cwd,
									name: group.name,
									count: group.sessions.length,
									icon: Folder,
									collapsedState: groupCollapsed,
									onToggle: () => toggleGroup(group.cwd),
									pinned: pinnedGroups.includes(group.cwd),
									current: group.cwd === cwd,
									onContextMenu: event => setGroupMenu({ anchor: anchorFromEvent(event), group }),
									renameInput: renaming ? (
										<input
											ref={groupRenameRef}
											value={groupRenameDraft}
											onChange={event => setGroupRenameDraft(event.target.value)}
											onClick={event => event.stopPropagation()}
											onBlur={() => {
												useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
												setRenamingGroupCwd(null);
											}}
											onKeyDown={event => {
												if (isImeKeyEvent(event)) return;
												if (event.key === "Enter") {
													useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
													setRenamingGroupCwd(null);
												}
												onEscape(event, () => setRenamingGroupCwd(null));
											}}
											className="min-w-0 flex-1 rounded-md border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1.5 py-0.5 text-omp-md text-[var(--omp-text)] outline-none"
										/>
									) : undefined,
									actions: (
										<>
											<button
												type="button"
												title={t("sidebar.menu.newAgentHere")}
												aria-label={t("sidebar.menu.newAgentHere")}
												className={rowActionButton}
												onClick={event => {
													event.stopPropagation();
													void openTab({ cwd: group.cwd });
												}}
											>
												<SquarePen size={12} />
											</button>
											<button
												type="button"
												title={t("sidebar.groupMenu")}
												aria-label={t("sidebar.groupMenu")}
												className={rowActionButton}
												onClick={event => {
													event.stopPropagation();
													const rect = event.currentTarget.getBoundingClientRect();
													setGroupMenu({ anchor: { x: rect.left, y: rect.bottom + 4 }, group });
												}}
											>
												<MoreHorizontal size={13} />
											</button>
										</>
									),
								})}
								{/* Collapsed groups render nothing: a long-lived install with
								    hundreds of sessions must not build the full DOM per
								    debounced refresh just to hide it. */}
								{!groupCollapsed && (
									<div className="omp-sidebar-group" data-session-group={group.cwd} data-state="expanded">
										<div className="omp-sidebar-group-content space-y-px">
											{group.sessions.map(session => renderSessionRow(session))}
										</div>
									</div>
								)}
							</div>
						);
					})}
					{mode === "code" && chatSessions.length > 0 && (
						<div className="mb-1" data-chat-section>
							{renderGroupHeader({
								id: "__chats__",
								name: t("sidebar.chats"),
								count: chatSessions.length,
								icon: MessageCircle,
								collapsedState: chatsCollapsed,
								onToggle: () => setCollapsed(prev => ({ ...prev, __chats__: !chatsCollapsed })),
							})}
							{!chatsCollapsed && (
								<div className="omp-sidebar-group" data-session-group="__chats__" data-state="expanded">
									<div className="omp-sidebar-group-content space-y-px">
										{chatSessions.map(session => renderSessionRow(session))}
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Footer: app-level controls that are not tied to a session. */}
				<div className="flex h-11 shrink-0 items-center gap-0.5 border-t border-[var(--omp-border-muted)] px-2">
					<button
						type="button"
						data-sidebar-settings
						onClick={() => useUiStore.getState().openSettings()}
						title={t("titlebar.settings")}
						aria-label={t("titlebar.settings")}
						className="omp-pressable flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-omp-md text-[var(--omp-text-secondary)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
					>
						<Settings aria-hidden="true" size={15} strokeWidth={1.75} className="shrink-0" />
						<span className="truncate">{t("titlebar.settings")}</span>
					</button>
					<div className="flex-1" />
					<button
						type="button"
						onClick={openThemePicker}
						title={t("themePicker.aria")}
						aria-label={t("themePicker.aria")}
						className={utilityButton}
					>
						<Palette size={15} strokeWidth={1.75} />
					</button>
					<LangSwitcher className="h-7 max-h-7 rounded-md px-1.5 text-omp-sm [&_svg]:size-[14px]" />
				</div>
				<div
					role="separator"
					aria-orientation="vertical"
					onPointerDown={startSidebarDrag}
					onPointerMove={onSidebarDrag}
					onPointerUp={endSidebarDrag}
					className="absolute inset-y-0 right-0 z-10 w-1 translate-x-1/2 cursor-col-resize transition-colors hover:bg-[var(--omp-accent)]/40 active:bg-[var(--omp-accent)] max-[1000px]:hidden"
				/>
			</aside>
			<WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} intent="new-session" />

			{/* App-wide tools: one menu instead of a second list competing with tasks. */}
			{moreMenu && (
				<ContextMenu
					x={moreMenu.x}
					y={moreMenu.y}
					onClose={() => setMoreMenu(null)}
					items={secondaryNavigation.map(item => ({
						id: `nav-${item.id}`,
						label: item.label,
						icon: item.icon,
						hint: item.shortcut,
						onSelect: () => {
							setMoreMenu(null);
							item.onClick();
						},
					}))}
				/>
			)}

			{/* Workspace group menu: new sessions, rename (alias), pin, delete. */}
			{groupMenu &&
				(() => {
					const groupHasBusySession = groupMenu.group.sessions.some(isSessionBusy);
					return (
						<ContextMenu
							x={groupMenu.anchor.x}
							y={groupMenu.anchor.y}
							onClose={() => setGroupMenu(null)}
							items={[
								{
									id: "group-new-agent",
									label: t("sidebar.menu.newAgentHere"),
									icon: SquareTerminal,
									onSelect: () => {
										setGroupMenu(null);
										void openTab({ cwd: groupMenu.group.cwd });
									},
								},
								{
									id: "group-new-worktree",
									label: t("sidebar.menu.newWorktreeHere"),
									icon: GitBranchPlus,
									onSelect: () => {
										setGroupMenu(null);
										useUiStore.getState().openWorktreeDialog({ baseCwd: groupMenu.group.cwd });
									},
								},
								{
									id: "group-rename",
									label: t("sidebar.menu.rename"),
									icon: Pencil,
									onSelect: () => {
										setGroupRenameDraft(groupMenu.group.name);
										setRenamingGroupCwd(groupMenu.group.cwd);
										setGroupMenu(null);
										requestAnimationFrame(() => groupRenameRef.current?.select());
									},
								},
								{
									id: "group-pin",
									label: pinnedGroups.includes(groupMenu.group.cwd)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedGroups.includes(groupMenu.group.cwd) ? PinOff : Pin,
									onSelect: () => {
										useSidebarPrefs.getState().toggleGroupPin(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
								{
									id: "group-delete",
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: groupHasBusySession,
									disabledReason: t("sidebar.deleteGroupStreaming"),
									onSelect: () => {
										setPendingDelete({ kind: "group", group: groupMenu.group });
										setGroupMenu(null);
									},
								},
							]}
						/>
					);
				})()}

			{/* Session row menu: open variants, per-task rename, pin, and delete. */}
			{sessionMenu &&
				(() => {
					const targetBusy = isSessionBusy(sessionMenu.session);
					return (
						<ContextMenu
							x={sessionMenu.anchor.x}
							y={sessionMenu.anchor.y}
							onClose={() => setSessionMenu(null)}
							items={[
								{
									id: "session-open",
									label: t("sidebar.menu.open"),
									icon: ChevronRight,
									onSelect: () => {
										setSessionMenu(null);
										void openSession(sessionMenu.session);
									},
								},
								{
									id: "session-open-tab",
									label: t("sidebar.menu.openNewTab"),
									icon: Plus,
									onSelect: () => {
										setSessionMenu(null);
										void openTab({
											cwd: sessionMenu.session.cwd,
											kind: sessionMenu.session.kind ?? "agent",
											sessionPath: sessionMenu.session.path,
										});
									},
								},
								{
									id: "session-open-window",
									label: t("sidebar.openInNewWindow"),
									icon: ExternalLink,
									onSelect: () => {
										setSessionMenu(null);
										void openSessionInNewWindow(sessionMenu.session);
									},
								},
								{
									id: "session-rename",
									label: t("sidebar.rename"),
									icon: Pencil,
									disabled: targetBusy,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setSessionMenu(null);
										startRename(sessionMenu.session);
									},
								},
								{
									id: "session-pin",
									label: pinnedSessions.includes(sessionMenu.session.path)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedSessions.includes(sessionMenu.session.path) ? PinOff : Pin,
									onSelect: () => {
										const pinned = !pinnedSessions.includes(sessionMenu.session.path);
										useSidebarPrefs.getState().toggleSessionPin(sessionMenu.session.path);
										setSessionMenu(null);
										void tabRpc.setSessionPinned(sessionMenu.session.id, pinned).then(response => {
											if (!response.success) {
												toast({ variant: "warning", message: t("sidebar.pinSyncFailed") });
											}
										});
									},
								},
								{
									id: "session-delete",
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: targetBusy,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setPendingDelete({ kind: "session", session: sessionMenu.session });
										setSessionMenu(null);
									},
								},
							]}
						/>
					);
				})()}

			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDelete?.kind === "group" ? t("sidebar.deleteGroupConfirm") : t("sidebar.deleteConfirm")}
				message={
					pendingDelete?.kind === "group"
						? t("sidebar.deleteGroupMessage", {
								name: pendingDelete.group.name,
								count: pendingDelete.group.sessions.length,
							})
						: pendingDelete?.kind === "session"
							? t("sidebar.deleteMessage", {
									name: sessionDisplayTitle(pendingDelete.session, t("sidebar.untitled")),
								})
							: ""
				}
				warning={pendingDelete?.kind === "group" ? t("sidebar.deleteGroupWarning") : undefined}
				busy={deleting}
				onConfirm={() => {
					if (pendingDelete?.kind === "group") void confirmDeleteGroup(pendingDelete.group);
					else if (pendingDelete) void confirmDeleteSession(pendingDelete.session);
				}}
				onCancel={() => setPendingDelete(null)}
			/>
		</>
	);
}
