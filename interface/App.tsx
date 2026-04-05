import { createSignal, onMount, onCleanup, For } from "solid-js";
import { Show } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import ThreadView from "./pages/Thread";
import ComposeView from "./pages/Compose";
import SearchPalette from "./components/SearchPalette";
import CommandPalette from "./components/CommandPalette";
import Inbox from "./pages/Inbox";
import type { ThreadRow } from "./pages/Inbox";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import SplitSetup from "./pages/SplitSetup";
import type { SplitConfig } from "./pages/SplitSetup";

interface OpenThread {
  id: string;
  subject: string;
}

interface InboxResponse {
  threads: ThreadRow[];
  nextPageToken: string | null;
}

const MAILBOX_DEFS = [
  { id: "done", label: "Done", query: "-in:inbox -in:trash -in:spam", emptyText: "No archived emails" },
  { id: "sent", label: "Sent", query: "in:sent", emptyText: "No sent emails" },
  { id: "drafts", label: "Drafts", query: "in:drafts", emptyText: "No drafts" },
  { id: "bin", label: "Bin", query: "in:trash", emptyText: "Bin is empty" },
  { id: "spam", label: "Spam", query: "in:spam", emptyText: "No spam" },
] as const;

export default function App() {
  const [authed, setAuthed] = createSignal<boolean | null>(null); // null = loading
  const [needsSetup, setNeedsSetup] = createSignal(false);
  const [splits, setSplits] = createSignal<SplitConfig[]>([]);

  // Per-split thread cache — switching tabs is instant
  const [splitThreads, setSplitThreads] = createSignal<Record<string, ThreadRow[]>>({});
  const [loadingSplits, setLoadingSplits] = createSignal<Set<string>>(new Set());

  // Derived from cache
  const threads = () => splitThreads()[activeTab()] ?? [];
  const loadingInbox = () => loadingSplits().has(activeTab());

  // Derive unread counts reactively from cached thread data so badge matches the list
  const unreadCounts = () => {
    const all = splitThreads();
    const out: Record<string, number> = {};
    for (const [id, list] of Object.entries(all)) {
      out[id] = list.filter((t) => !t.isRead).length;
    }
    return out;
  };
  const [activeTab, setActiveTab] = createSignal("important");
  const [openThread, setOpenThread] = createSignal<OpenThread | null>(null);
  const [showCompose, setShowCompose] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);
  const [showCommandBar, setShowCommandBar] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [inlineReply, setInlineReply] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);

  // Unified mailbox state
  const [mailboxes, setMailboxes] = createSignal<Record<string, { threads: ThreadRow[]; loading: boolean }>>(
    Object.fromEntries(MAILBOX_DEFS.map((m) => [m.id, { threads: [], loading: false }]))
  );
  const [activeMailbox, setActiveMailbox] = createSignal<string | null>(null);

  // Bump this whenever default split queries change to force re-setup
  const SPLITS_VERSION = 5;

  const checkAuth = async () => {
    try {
      const has = await invoke<boolean>("has_accounts");
      setAuthed(has);
      if (has) {
        const saved = await invoke<SplitConfig[]>("get_splits");
        const savedVersion = await invoke<number | null>("get_setting", { key: "splits_version" }).catch(() => null);
        const isStale = saved.length === 0 || savedVersion !== SPLITS_VERSION;
        if (!isStale) {
          setSplits(saved);
          setActiveTab(saved[0].id);
          loadAllSplits();
          prefetchAllMailboxes();
        } else {
          setNeedsSetup(true);
        }
      }
    } catch {
      setAuthed(false);
    }
  };

  // Build the query for a split, excluding other splits from broad catch-all splits only
  const buildQueryForSplit = (splitId: string): string | undefined => {
    const allSplits = splits();
    const split = allSplits.find((s) => s.id === splitId);
    if (!split?.query) return undefined;

    // label: splits manage their own scope; category: splits get exclusions below
    if (split.query.startsWith("label:")) return `in:inbox ${split.query}`;

    // Other specific matchers (from:, filename:, OR groups, etc.) need in:inbox
    // so archived threads don't pollute listings and unread badges
    if (!split.query.startsWith("category:")) return `in:inbox ${split.query}`;

    // Collect other non-label, non-category splits' queries to exclude
    const others = allSplits
      .filter((s) => s.id !== splitId && s.query && !s.query.startsWith("label:") && !s.query.startsWith("category:"))
      .map((s) => s.query!);

    if (others.length === 0) return split.query;

    // Negate each other split's terms
    const exclusions = others
      .map((q) => {
        if (q.startsWith("{") && q.endsWith("}")) {
          // OR group like {filename:ics from:x} — negate each term
          return q.slice(1, -1).trim().split(/\s+/).map((t) => `-${t}`).join(" ");
        }
        return `-${q}`;
      })
      .join(" ");

    return `${split.query} ${exclusions}`;
  };

  // Prefetch all splits concurrently — each result updates cache as it arrives
  const loadAllSplits = async () => {
    const allSplits = splits();
    if (allSplits.length === 0) return;

    setLoadingSplits(new Set(allSplits.map((s) => s.id)));

    await Promise.all(
      allSplits.map(async (split) => {
        const query = buildQueryForSplit(split.id);
        try {
          const res = await invoke<InboxResponse>("list_inbox", {
            maxResults: 50,
            labelId: null,
            query: query ?? null,
          });
          setSplitThreads((prev) => ({ ...prev, [split.id]: res.threads }));
        } catch (e) {
          console.error(`Failed to load ${split.id}:`, e);
        } finally {
          setLoadingSplits((prev) => {
            const next = new Set(prev);
            next.delete(split.id);
            return next;
          });
        }
      })
    );
  };

  // Switching tabs is instant — data already in cache
  const loadSplit = (splitId: string) => {
    setActiveTab(splitId);
    setActiveMailbox(null);
  };

  // Unified mailbox prefetch
  const prefetchMailbox = async (id: string) => {
    const def = MAILBOX_DEFS.find((m) => m.id === id);
    if (!def) return;
    setMailboxes((prev) => ({ ...prev, [id]: { ...prev[id], loading: true } }));
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: def.query,
      });
      setMailboxes((prev) => ({ ...prev, [id]: { threads: res.threads, loading: false } }));
    } catch (e) {
      console.error(`Failed to load ${id}:`, e);
      setMailboxes((prev) => ({ ...prev, [id]: { ...prev[id], loading: false } }));
    }
  };

  const prefetchAllMailboxes = () => {
    for (const def of MAILBOX_DEFS) prefetchMailbox(def.id);
  };

  const closeAllViews = () => {
    setActiveMailbox(null);
    setOpenThread(null);
    setShowSettings(false);
    setShowCompose(false);
  };

  const openMailbox = (id: string) => {
    closeAllViews();
    setActiveMailbox(id);
  };

  const onAuthComplete = () => {
    setAuthed(true);
    setNeedsSetup(true);
  };

  const onSetupComplete = async (chosen: SplitConfig[]) => {
    setSplits(chosen);
    setNeedsSetup(false);
    await invoke("save_splits", { splits: chosen }).catch(console.error);
    await invoke("save_setting", { key: "splits_version", value: SPLITS_VERSION }).catch(console.error);
    if (chosen.length > 0) {
      setActiveTab(chosen[0].id);
      loadAllSplits();
      prefetchAllMailboxes();
    }
  };

  const threadIds = () => threads().map((t) => t.id);

  const selectAndOpen = (id: string) => {
    setSelectedId(id);
    const thread = threads().find((t) => t.id === id);
    if (thread) {
      setOpenThread({ id: thread.id, subject: thread.subject });
      if (!thread.isRead) markThreadRead(id);
    }
  };

  const markThreadRead = (threadId: string) => {
    // Optimistic: mark as read in all caches immediately
    setSplitThreads((prev) => {
      const next: Record<string, ThreadRow[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.map((t) => t.id === threadId ? { ...t, isRead: true } : t);
      }
      return next;
    });
    // Fire API call in background
    invoke("mark_thread_read", { threadId }).catch((e) =>
      console.error("Failed to mark read:", e)
    );
  };

  const navigateThread = (direction: 1 | -1) => {
    const ids = threadIds();
    if (ids.length === 0) return;
    const current = selectedId();
    const idx = current ? ids.indexOf(current) : -1;
    const next = idx + direction;
    if (next >= 0 && next < ids.length) selectAndOpen(ids[next]);
  };

  // Unified archive/trash: optimistic UI removal + Gmail API call
  const removeThread = async (
    threadId: string,
    action: "archive" | "trash",
  ) => {
    const removedThread = threads().find((t) => t.id === threadId);

    const currentIds = threadIds();
    const currentIdx = currentIds.indexOf(threadId);
    let nextThread: OpenThread | null = null;
    if (currentIdx >= 0) {
      const nextId = currentIds[currentIdx + 1] ?? currentIds[currentIdx - 1];
      if (nextId) {
        const t = threads().find((th) => th.id === nextId);
        if (t) nextThread = { id: t.id, subject: t.subject };
      }
    }

    // Optimistic: remove from all split caches
    setSplitThreads((prev) => {
      const next: Record<string, ThreadRow[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.filter((t) => t.id !== threadId);
      }
      return next;
    });

    // Optimistic: add to target mailbox
    if (removedThread) {
      const targetMailbox = action === "archive" ? "done" : "bin";
      setMailboxes((prev) => ({
        ...prev,
        [targetMailbox]: { ...prev[targetMailbox], threads: [removedThread, ...prev[targetMailbox].threads] },
      }));
    }

    // If viewing this thread, advance to next
    if (openThread()?.id === threadId) {
      setInlineReply(false);
      if (nextThread) {
        setOpenThread(nextThread);
        setSelectedId(nextThread.id);
      } else {
        setOpenThread(null);
        setSelectedId(null);
      }
    } else {
      if (nextThread) {
        setSelectedId(nextThread.id);
      } else {
        setSelectedId(null);
      }
    }

    const command = action === "archive" ? "archive_thread" : "trash_thread";
    try {
      await invoke(command, { threadId });
    } catch (e) {
      console.error(`${action} failed:`, e);
      loadAllSplits();
    }
  };

  const archiveThread = (threadId: string) => removeThread(threadId, "archive");
  const trashThread = (threadId: string) => removeThread(threadId, "trash");

  const handleLogout = async () => {
    try {
      await invoke("logout");
      setAuthed(false);
      setSplitThreads({});
      setMailboxes(
        Object.fromEntries(MAILBOX_DEFS.map((m) => [m.id, { threads: [], loading: false }]))
      );
      setSplits([]);
      setNeedsSetup(false);
      setOpenThread(null);
      setShowCompose(false);
      setShowSettings(false);
      setActiveMailbox(null);
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  const handleCommand = (id: string) => {
    switch (id) {
      case "inbox": setShowSettings(false); setShowCompose(false); setOpenThread(null); break;
      case "compose": setShowCompose(true); break;
      case "search": setShowSearch(true); break;
      case "settings": setShowSettings(true); break;
      case "account": handleLogout(); break;
      case "done": openMailbox("done"); break;
      case "sent": openMailbox("sent"); break;
      case "drafts": openMailbox("drafts"); break;
      case "bin":
      case "trash-folder": openMailbox("bin"); break;
      case "spam":
      case "spam-folder": openMailbox("spam"); break;
      case "archive":
      case "mark-done": {
        const tid = openThread()?.id ?? selectedId();
        if (tid) archiveThread(tid);
        break;
      }
      case "delete":
      case "trash": {
        const tid = openThread()?.id ?? selectedId();
        if (tid) trashThread(tid);
        break;
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (e.key === "Escape") {
      if (showCompose()) { setShowCompose(false); return; }
      if (showSearch()) { setShowSearch(false); return; }
      if (showCommandBar()) { setShowCommandBar(false); return; }
      if (inlineReply()) { setInlineReply(false); return; }
      if (showSettings()) { setShowSettings(false); return; }
      if (activeMailbox()) { setActiveMailbox(null); return; }
      if (openThread()) { setOpenThread(null); return; }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setShowCommandBar((v) => !v);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const s = splits();
      const tabIds = s.length > 0 ? s.map((sp) => sp.id) : ["inbox"];
      const idx = tabIds.indexOf(activeTab());
      const nextIdx = e.shiftKey
        ? (idx - 1 + tabIds.length) % tabIds.length
        : (idx + 1) % tabIds.length;
      loadSplit(tabIds[nextIdx]);
      return;
    }

    if (isInput) return;
    if (showCompose() || showSearch() || showCommandBar()) return;

    switch (e.key) {
      case "j": e.preventDefault(); navigateThread(1); break;
      case "k": e.preventDefault(); navigateThread(-1); break;
      case "Enter":
        e.preventDefault();
        if (!openThread() && selectedId()) selectAndOpen(selectedId()!);
        break;
      case "c":
        e.preventDefault();
        setShowCompose(true);
        break;
      case "r":
        if (openThread()) {
          e.preventDefault();
          setInlineReply(true);
        }
        break;
      case "e": {
        e.preventDefault();
        const id = openThread()?.id ?? selectedId();
        if (id) archiveThread(id);
        break;
      }
      case "#": {
        e.preventDefault();
        const id = openThread()?.id ?? selectedId();
        if (id) trashThread(id);
        break;
      }
      case "/": e.preventDefault(); setShowSearch(true); break;
    }
  };

  onMount(() => {
    checkAuth();
    document.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <Show when={authed() !== null} fallback={
      <div class="h-screen w-screen bg-white" data-tauri-drag-region />
    }>
    <Show when={authed()} fallback={
      <Onboarding onComplete={onAuthComplete} />
    }>
    <Show when={!needsSetup()} fallback={
      <SplitSetup onComplete={onSetupComplete} />
    }>
    <div class="h-screen w-screen bg-white text-zinc-900 flex overflow-hidden">
      {/* ── Sidebar — dark, minimal ── */}
      <aside class="w-14 flex-shrink-0 bg-white flex flex-col items-center select-none">
        {/* Traffic light spacing — no border here */}
        <div class="h-12 flex-shrink-0" data-tauri-drag-region />

        {/* Border starts below traffic lights, runs to bottom */}
        <div class="flex-1 w-full border-r border-zinc-200/60 flex flex-col items-center">
          {/* Workspace icon — sub items show on hover */}
          <div class="mt-1 group/ws">
            <div class="w-8 h-8 rounded-full border border-zinc-200 flex items-center justify-center text-[11px] font-medium text-zinc-400 cursor-pointer hover:border-zinc-300 hover:text-zinc-600 transition-colors mx-auto" title="Workspace">
              OS
            </div>
            <div class="hidden group-hover/ws:flex flex-col items-center space-y-3 mt-3">
              <SidebarIcon icon="done" label="done" onClick={() => openMailbox("done")} />
              <SidebarIcon icon="sent" label="sent" onClick={() => openMailbox("sent")} />
              <SidebarIcon icon="drafts" label="drafts" onClick={() => openMailbox("drafts")} />
              <SidebarIcon icon="bin" label="bin" onClick={() => openMailbox("bin")} />
              <SidebarIcon icon="spam" label="spam" onClick={() => openMailbox("spam")} />
            </div>
          </div>
          <div class="flex-1" />
          {/* Shortcuts guide */}
          <div class="pb-4 space-y-3">
            <ShortcutHint hotkey="/" label="search" onClick={() => setShowSearch(true)} />
            <ShortcutHint hotkey="⌘K" label="config" onClick={() => setShowCommandBar(true)} />
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div class="flex-1 flex flex-col min-w-0">
        {/* Nav: drag region + split inbox tabs (hidden when thread/compose open) */}
        <div class="flex-shrink-0" data-tauri-drag-region>
          <div class="h-10" data-tauri-drag-region />
          <Show when={!openThread() && !showCompose() && !showSettings() && !activeMailbox()}>
            <div class="flex items-center gap-0 px-20 pb-0" data-tauri-drag-region>
              <For each={splits().length > 0
                ? splits().map((s) => ({ id: s.id, label: s.name, gmailLabelId: s.gmailLabelId, query: s.query }))
                : [{ id: "inbox", label: "Inbox", gmailLabelId: undefined as string | undefined, query: undefined as string | undefined }]
              }>
                {(tab, i) => {
                  const count = () => unreadCounts()[tab.id] ?? 0;
                  return (
                    <button
                      onClick={() => loadSplit(tab.id)}
                      class={`relative py-2.5 text-[13px] transition-colors ${i() === 0 ? "pr-3" : "px-3"} ${
                        activeTab() === tab.id
                          ? "text-zinc-900 font-medium"
                          : "text-zinc-400 hover:text-zinc-600"
                      }`}
                    >
                      {tab.label}
                      <Show when={count() > 0}>
                        <span class={`ml-1.5 text-[11px] tabular-nums ${
                          activeTab() === tab.id ? "text-zinc-500" : "text-zinc-400"
                        }`}>
                          {count()}
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex-1 relative overflow-hidden">
          <Show when={showSettings()} fallback={
          <Show when={activeMailbox()} fallback={
          <Show when={showCompose()} fallback={
            <Show when={openThread()} fallback={
              <Inbox
                threads={threads()}
                loading={loadingInbox()}
                selectedId={selectedId()}
                onSelect={selectAndOpen}
                onOpenThread={(t) => setOpenThread(t)}
                onArchive={archiveThread}
                onTrash={trashThread}
              />
            }>
              {(thread) => (
                <div class="flex h-full">
                  <div class="flex-1 min-w-0">
                    <ThreadView
                      threadId={thread().id}
                      subject={thread().subject}
                      onBack={() => { setOpenThread(null); setInlineReply(false); }}
                      replyOpen={inlineReply()}
                      onReplyOpen={() => setInlineReply(true)}
                      onReplyClose={() => setInlineReply(false)}
                    />
                  </div>
                  <div class="w-[260px] flex-shrink-0 overflow-y-auto">
                    <ContactSidebar threadId={thread().id} threads={threads()} />
                  </div>
                </div>
              )}
            </Show>
          }>
            <ComposeView onClose={() => setShowCompose(false)} />
          </Show>
          }>
            {(mbId) => {
              const def = () => MAILBOX_DEFS.find((m) => m.id === mbId())!;
              const mb = () => mailboxes()[mbId()];
              return (
                <MailboxView
                  label={def().label}
                  emptyText={def().emptyText}
                  threads={mb().threads}
                  loading={mb().loading}
                  onBack={() => setActiveMailbox(null)}
                  onOpenThread={(thread) => {
                    setSelectedId(thread.id);
                    setOpenThread({ id: thread.id, subject: thread.subject });
                  }}
                />
              );
            }}
          </Show>
          }>
            <Settings onBack={() => setShowSettings(false)} />
          </Show>
        </div>
      </div>

      {/* ── Overlays ── */}
      <Show when={showSearch()}>
        <SearchPalette
          onClose={() => setShowSearch(false)}
          onSelectThread={(id, subject) => {
            closeAllViews();
            setSelectedId(id);
            setOpenThread({ id, subject });
            markThreadRead(id);
          }}
        />
      </Show>
      <Show when={showCommandBar()}>
        <CommandPalette onClose={() => setShowCommandBar(false)} onCommand={handleCommand} />
      </Show>
    </div>
    </Show>
    </Show>
    </Show>
  );
}

/* ── Mailbox view ── */

function MailboxView(props: {
  label: string;
  emptyText: string;
  threads: ThreadRow[];
  loading: boolean;
  onBack: () => void;
  onOpenThread: (thread: ThreadRow) => void;
}) {
  return (
    <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
      <div class="flex items-center gap-2 px-20 mb-4">
        <button onClick={props.onBack} class="text-zinc-400 hover:text-zinc-600 transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
        <span class="text-[15px] font-medium text-zinc-900">{props.label}</span>
      </div>
      <Show when={!props.loading} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
      }>
      <Show when={props.threads.length > 0} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">{props.emptyText}</div>
      }>
        <For each={props.threads}>
          {(thread) => (
            <div
              class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
              onClick={() => props.onOpenThread(thread)}
            >
              <div class="w-40 flex-shrink-0 truncate">
                <span class="text-[13px] text-zinc-500">{thread.fromName}</span>
              </div>
              <div class="flex-1 min-w-0 truncate">
                <span class="text-[13px] text-zinc-400">{thread.subject}</span>
              </div>
              <div class="text-[12px] text-zinc-400 tabular-nums">{thread.date}</div>
            </div>
          )}
        </For>
      </Show>
      </Show>
    </div>
  );
}

/* ── Sidebar icon ── */

function SidebarIcon(props: { icon: string; label: string; onClick?: () => void }) {
  const icons: Record<string, () => any> = {
    done: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.5 8l3 3 6-6" />
      </svg>
    ),
    sent: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2L7 9" />
        <path d="M14 2l-4 12-3-5-5-3z" />
      </svg>
    ),
    drafts: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 00-2 2v7a2 2 0 002 2h8a2 2 0 002-2V8" />
        <path d="M10.5 1.5l2 2L8 8H6V6l4.5-4.5z" />
      </svg>
    ),
    bin: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4" />
      </svg>
    ),
    spam: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5.24 1.33 10.76 1.33 14.67 5.24 14.67 10.76 10.76 14.67 5.24 14.67 1.33 10.76 1.33 5.24" />
        <line x1="8" y1="5.33" x2="8" y2="8" />
        <line x1="8" y1="10.67" x2="8.01" y2="10.67" />
      </svg>
    ),
  };
  const Icon = icons[props.icon];
  return (
    <button
      onClick={props.onClick}
      class="flex flex-col items-center gap-0.5 group cursor-pointer"
    >
      <div class="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 group-hover:text-zinc-600 transition-colors">
        {Icon ? <Icon /> : null}
      </div>
      <span class="text-[9px] text-zinc-400 group-hover:text-zinc-600 transition-colors">{props.label}</span>
    </button>
  );
}

/* ── Shortcut hint ── */

function ShortcutHint(props: { hotkey: string; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={props.onClick}
      class="flex flex-col items-center gap-0.5 group cursor-pointer"
    >
      <kbd class="w-7 h-7 rounded-md bg-white border border-zinc-200 flex items-center justify-center text-[11px] text-zinc-400 font-mono shadow-sm group-hover:border-zinc-300 group-hover:text-zinc-600 transition-colors">
        {props.hotkey}
      </kbd>
      <span class="text-[9px] text-zinc-400 group-hover:text-zinc-600 transition-colors">{props.label}</span>
    </button>
  );
}

/* ── Contact sidebar ── */

function ContactSidebar(props: { threadId: string; threads: ThreadRow[] }) {
  const thread = () => props.threads.find((t) => t.id === props.threadId);

  // Build contact from thread data — other threads from same sender
  const contact = () => {
    const t = thread();
    const name = t?.fromName ?? "Unknown";
    const email = t?.fromEmail ?? "";
    const senderThreads = props.threads
      .filter((th) => th.fromEmail === email && th.id !== props.threadId)
      .slice(0, 5)
      .map((th) => ({ subject: th.subject, date: th.date }));
    return { name, title: email, location: "", emails: senderThreads, links: [] as { label: string; url: string }[] };
  };

  return (
    <div class="p-5 space-y-5">
      {/* Contact header */}
      <div class="flex items-start gap-3">
        <div class="w-9 h-9 rounded-full bg-zinc-100 flex items-center justify-center text-[13px] font-medium text-zinc-500 flex-shrink-0">
          {contact().name[0]?.toUpperCase()}
        </div>
        <div class="min-w-0">
          <div class="text-[14px] font-medium text-zinc-800 truncate">{contact().name}</div>
          <div class="text-[12px] text-zinc-400 truncate">{contact().title}</div>
          <Show when={contact().location}>
            <div class="text-[12px] text-zinc-400 mt-0.5">{contact().location}</div>
          </Show>
        </div>
      </div>

      {/* Mail section */}
      <Show when={contact().emails.length > 0}>
        <div>
          <div class="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Mail</div>
          <div class="space-y-1.5">
            <For each={contact().emails}>
              {(email) => (
                <div class="text-[12px] text-zinc-500 truncate">
                  {email.subject}
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Links section */}
      <Show when={contact().links.length > 0}>
        <div>
          <div class="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Links</div>
          <div class="space-y-1.5">
            <For each={contact().links}>
              {(link) => (
                <a href={link.url} class="text-[12px] text-blue-500 hover:underline block truncate">
                  {link.label}
                </a>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
