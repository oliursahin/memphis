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

  const [unreadCounts, setUnreadCounts] = createSignal<Record<string, number>>({});
  const [activeTab, setActiveTab] = createSignal("important");
  const [openThread, setOpenThread] = createSignal<OpenThread | null>(null);
  const [showCompose, setShowCompose] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);
  const [showCommandBar, setShowCommandBar] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [inlineReply, setInlineReply] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showDone, setShowDone] = createSignal(false);
  const [doneThreads, setDoneThreads] = createSignal<ThreadRow[]>([]);
  const [loadingDone, setLoadingDone] = createSignal(false);
  const [showSent, setShowSent] = createSignal(false);
  const [sentThreads, setSentThreads] = createSignal<ThreadRow[]>([]);
  const [loadingSent, setLoadingSent] = createSignal(false);
  const [showDrafts, setShowDrafts] = createSignal(false);
  const [draftsThreads, setDraftsThreads] = createSignal<ThreadRow[]>([]);
  const [loadingDrafts, setLoadingDrafts] = createSignal(false);
  const [showBin, setShowBin] = createSignal(false);
  const [binThreads, setBinThreads] = createSignal<ThreadRow[]>([]);
  const [loadingBin, setLoadingBin] = createSignal(false);
  const [showSpam, setShowSpam] = createSignal(false);
  const [spamThreads, setSpamThreads] = createSignal<ThreadRow[]>([]);
  const [loadingSpam, setLoadingSpam] = createSignal(false);

  const fetchUnreadCounts = async (splitList: SplitConfig[]) => {
    // Build queries with exclusions so counts are mutually exclusive
    const queries = splitList.map((split) => {
      const q = buildQueryForSplit(split.id) ?? "";
      return { id: split.id, query: q };
    });
    try {
      const counts = await invoke<{ id: string; unreadCount: number }[]>("get_unread_counts", { splits: queries });
      const map: Record<string, number> = {};
      for (const c of counts) map[c.id] = c.unreadCount;
      setUnreadCounts(map);
    } catch (e) {
      console.error("Failed to fetch unread counts:", e);
    }
  };

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
          prefetchDone();
          prefetchSent();
          prefetchDrafts();
          prefetchBin();
          prefetchSpam();
          fetchUnreadCounts(saved);
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

    // Only broad category splits (category:*) get exclusions — specific matchers
    // (from:, filename:, label:, etc.) use their raw queries
    if (!split.query.startsWith("category:")) return split.query;

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
    setShowDone(false);
    setShowSent(false);
    setShowDrafts(false);
    setShowBin(false);
    setShowSpam(false);
  };

  const prefetchDone = async () => {
    setLoadingDone(true);
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: "-in:inbox -in:trash -in:spam",
      });
      setDoneThreads(res.threads);
    } catch (e) {
      console.error("Failed to load done:", e);
    } finally {
      setLoadingDone(false);
    }
  };

  const prefetchSent = async () => {
    setLoadingSent(true);
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: "in:sent",
      });
      setSentThreads(res.threads);
    } catch (e) {
      console.error("Failed to load sent:", e);
    } finally {
      setLoadingSent(false);
    }
  };

  const prefetchDrafts = async () => {
    setLoadingDrafts(true);
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: "in:drafts",
      });
      setDraftsThreads(res.threads);
    } catch (e) {
      console.error("Failed to load drafts:", e);
    } finally {
      setLoadingDrafts(false);
    }
  };

  const prefetchBin = async () => {
    setLoadingBin(true);
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: "in:trash",
      });
      setBinThreads(res.threads);
    } catch (e) {
      console.error("Failed to load bin:", e);
    } finally {
      setLoadingBin(false);
    }
  };

  const closeAllViews = () => {
    setShowDone(false);
    setShowSent(false);
    setShowDrafts(false);
    setShowBin(false);
    setShowSpam(false);
    setOpenThread(null);
    setShowSettings(false);
    setShowCompose(false);
  };

  const prefetchSpam = async () => {
    setLoadingSpam(true);
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: "in:spam",
      });
      setSpamThreads(res.threads);
    } catch (e) {
      console.error("Failed to load spam:", e);
    } finally {
      setLoadingSpam(false);
    }
  };

  const openSentView = () => {
    closeAllViews();
    setShowSent(true);
  };

  const openDoneView = () => {
    closeAllViews();
    setShowDone(true);
  };

  const openDraftsView = () => {
    closeAllViews();
    setShowDrafts(true);
  };

  const openBinView = () => {
    closeAllViews();
    setShowBin(true);
  };

  const openSpamView = () => {
    closeAllViews();
    setShowSpam(true);
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
      prefetchDone();
      prefetchSent();
      prefetchDrafts();
      prefetchBin();
      prefetchSpam();
      fetchUnreadCounts(chosen);
    }
  };

  const threadIds = () => threads().map((t) => t.id);

  const selectAndOpen = (id: string) => {
    setSelectedId(id);
    const thread = threads().find((t) => t.id === id);
    if (thread) setOpenThread({ id: thread.id, subject: thread.subject });
  };

  const navigateThread = (direction: 1 | -1) => {
    const ids = threadIds();
    if (ids.length === 0) return;
    const current = selectedId();
    const idx = current ? ids.indexOf(current) : -1;
    const next = idx + direction;
    if (next >= 0 && next < ids.length) selectAndOpen(ids[next]);
  };

  // Archive thread: optimistic UI removal + Gmail API call
  const archiveThread = async (threadId: string) => {
    // Find the thread before removing so we can add it to done
    const archivedThread = threads().find((t) => t.id === threadId);

    // Compute the next thread BEFORE removing from cache
    const currentIds = threadIds();
    const currentIdx = currentIds.indexOf(threadId);
    let nextThread: { id: string; subject: string } | null = null;
    if (currentIdx >= 0) {
      // Prefer next, then previous
      const nextId = currentIds[currentIdx + 1] ?? currentIds[currentIdx - 1];
      if (nextId) {
        const t = threads().find((th) => th.id === nextId);
        if (t) nextThread = { id: t.id, subject: t.subject };
      }
    }

    // Optimistic: remove from all split caches immediately
    setSplitThreads((prev) => {
      const next: Record<string, ThreadRow[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.filter((t) => t.id !== threadId);
      }
      return next;
    });

    // Optimistic: add to done list
    if (archivedThread) {
      setDoneThreads((prev) => [archivedThread, ...prev]);
    }

    // If viewing this thread, advance to next thread (stay in thread view)
    if (openThread()?.id === threadId) {
      setInlineReply(false);
      if (nextThread) {
        setOpenThread(nextThread);
        setSelectedId(nextThread.id);
      } else {
        // No more threads — go back to list
        setOpenThread(null);
        setSelectedId(null);
      }
    } else {
      // Not viewing — just advance selection in list
      if (nextThread) {
        setSelectedId(nextThread.id);
      } else {
        setSelectedId(null);
      }
    }

    // Fire API call in background
    try {
      await invoke("archive_thread", { threadId });
    } catch (e) {
      console.error("Archive failed:", e);
      // On failure, refetch the active split to restore
      loadAllSplits();
    }
  };

  const handleLogout = async () => {
    try {
      await invoke("logout");
      setAuthed(false);
      setSplitThreads({});
      setDoneThreads([]);
      setSentThreads([]);
      setDraftsThreads([]);
      setBinThreads([]);
      setSpamThreads([]);
      setSplits([]);
      setNeedsSetup(false);
      setOpenThread(null);
      setShowCompose(false);
      setShowSettings(false);
      setShowDone(false);
      setShowSent(false);
      setShowDrafts(false);
      setShowBin(false);
      setShowSpam(false);
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
      case "done": openDoneView(); break;
      case "sent": openSentView(); break;
      case "drafts": openDraftsView(); break;
      case "bin":
      case "trash-folder": openBinView(); break;
      case "spam":
      case "spam-folder": openSpamView(); break;
      case "archive":
      case "mark-done": {
        const tid = openThread()?.id ?? selectedId();
        if (tid) archiveThread(tid);
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
      if (showDone()) { setShowDone(false); return; }
      if (showSent()) { setShowSent(false); return; }
      if (showDrafts()) { setShowDrafts(false); return; }
      if (showBin()) { setShowBin(false); return; }
      if (showSpam()) { setShowSpam(false); return; }
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
              <SidebarIcon icon="done" label="done" onClick={openDoneView} />
              <SidebarIcon icon="sent" label="sent" onClick={openSentView} />
              <SidebarIcon icon="drafts" label="drafts" onClick={openDraftsView} />
              <SidebarIcon icon="bin" label="bin" onClick={openBinView} />
              <SidebarIcon icon="spam" label="spam" onClick={openSpamView} />
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
          <Show when={!openThread() && !showCompose() && !showSettings() && !showDone() && !showSent() && !showDrafts() && !showBin() && !showSpam()}>
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
          <Show when={showSpam()} fallback={
          <Show when={showBin()} fallback={
          <Show when={showDrafts()} fallback={
          <Show when={showSent()} fallback={
          <Show when={showDone()} fallback={
          <Show when={showCompose()} fallback={
            <Show when={openThread()} fallback={
              <Inbox
                threads={threads()}
                loading={loadingInbox()}
                selectedId={selectedId()}
                onSelect={selectAndOpen}
                onOpenThread={(t) => setOpenThread(t)}
                onArchive={archiveThread}
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
            <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
              <div class="flex items-center gap-2 px-20 mb-4">
                <button onClick={() => setShowDone(false)} class="text-zinc-400 hover:text-zinc-600 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 12L6 8l4-4" />
                  </svg>
                </button>
                <span class="text-[15px] font-medium text-zinc-900">Done</span>
              </div>
              <Show when={!loadingDone()} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
              }>
              <Show when={doneThreads().length > 0} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">No archived emails</div>
              }>
                <For each={doneThreads()}>
                  {(thread) => (
                    <div
                      class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
                      onClick={() => {
                        setSelectedId(thread.id);
                        setOpenThread({ id: thread.id, subject: thread.subject });
                      }}
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
          </Show>
          }>
            <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
              <div class="flex items-center gap-2 px-20 mb-4">
                <button onClick={() => setShowSent(false)} class="text-zinc-400 hover:text-zinc-600 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 12L6 8l4-4" />
                  </svg>
                </button>
                <span class="text-[15px] font-medium text-zinc-900">Sent</span>
              </div>
              <Show when={!loadingSent()} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
              }>
              <Show when={sentThreads().length > 0} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">No sent emails</div>
              }>
                <For each={sentThreads()}>
                  {(thread) => (
                    <div
                      class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
                      onClick={() => {
                        setSelectedId(thread.id);
                        setOpenThread({ id: thread.id, subject: thread.subject });
                      }}
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
          </Show>
          }>
            <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
              <div class="flex items-center gap-2 px-20 mb-4">
                <button onClick={() => setShowDrafts(false)} class="text-zinc-400 hover:text-zinc-600 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 12L6 8l4-4" />
                  </svg>
                </button>
                <span class="text-[15px] font-medium text-zinc-900">Drafts</span>
              </div>
              <Show when={!loadingDrafts()} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
              }>
              <Show when={draftsThreads().length > 0} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">No drafts</div>
              }>
                <For each={draftsThreads()}>
                  {(thread) => (
                    <div
                      class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
                      onClick={() => {
                        setSelectedId(thread.id);
                        setOpenThread({ id: thread.id, subject: thread.subject });
                      }}
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
          </Show>
          }>
            <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
              <div class="flex items-center gap-2 px-20 mb-4">
                <button onClick={() => setShowBin(false)} class="text-zinc-400 hover:text-zinc-600 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 12L6 8l4-4" />
                  </svg>
                </button>
                <span class="text-[15px] font-medium text-zinc-900">Bin</span>
              </div>
              <Show when={!loadingBin()} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
              }>
              <Show when={binThreads().length > 0} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Bin is empty</div>
              }>
                <For each={binThreads()}>
                  {(thread) => (
                    <div
                      class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
                      onClick={() => {
                        setSelectedId(thread.id);
                        setOpenThread({ id: thread.id, subject: thread.subject });
                      }}
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
          </Show>
          }>
            <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
              <div class="flex items-center gap-2 px-20 mb-4">
                <button onClick={() => setShowSpam(false)} class="text-zinc-400 hover:text-zinc-600 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10 12L6 8l4-4" />
                  </svg>
                </button>
                <span class="text-[15px] font-medium text-zinc-900">Spam</span>
              </div>
              <Show when={!loadingSpam()} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
              }>
              <Show when={spamThreads().length > 0} fallback={
                <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">No spam</div>
              }>
                <For each={spamThreads()}>
                  {(thread) => (
                    <div
                      class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
                      onClick={() => {
                        setSelectedId(thread.id);
                        setOpenThread({ id: thread.id, subject: thread.subject });
                      }}
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
          onSelectThread={(id) => selectAndOpen(id)}
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
