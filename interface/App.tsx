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

  const handleLogout = async () => {
    try {
      await invoke("logout");
      setAuthed(false);
      setSplitThreads({});
      setSplits([]);
      setNeedsSetup(false);
      setOpenThread(null);
      setShowCompose(false);
      setShowSettings(false);
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
              <SidebarIcon icon="done" label="done" />
              <SidebarIcon icon="sent" label="sent" />
              <SidebarIcon icon="drafts" label="drafts" />
              <SidebarIcon icon="bin" label="bin" />
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
          <Show when={!openThread() && !showCompose() && !showSettings()}>
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
          <Show when={showCompose()} fallback={
            <Show when={openThread()} fallback={
              <Inbox
                threads={threads()}
                loading={loadingInbox()}
                selectedId={selectedId()}
                onSelect={selectAndOpen}
                onOpenThread={(t) => setOpenThread(t)}
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
