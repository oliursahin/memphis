import { createSignal, onMount, onCleanup, For } from "solid-js";
import { Show } from "solid-js/web";
import ThreadView from "./components/ThreadView";
import ComposeView from "./components/ComposeModal";
import SearchOverlay from "./components/SearchOverlay";
import CommandBar from "./components/CommandBar";
import Inbox, { MOCK_THREADS } from "./pages/Inbox";

interface OpenThread {
  id: string;
  subject: string;
}

export default function App() {
  const [activeTab, setActiveTab] = createSignal("important");
  const [openThread, setOpenThread] = createSignal<OpenThread | null>(null);
  const [showCompose, setShowCompose] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);
  const [showCommandBar, setShowCommandBar] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [inlineReply, setInlineReply] = createSignal(false);

  const threadIds = () => MOCK_THREADS.map((t) => t.id);

  const selectAndOpen = (id: string) => {
    setSelectedId(id);
    const thread = MOCK_THREADS.find((t) => t.id === id);
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

  const handleCommand = (id: string) => {
    switch (id) {
      case "inbox": break;
      case "compose": setShowCompose(true); break;
      case "search": setShowSearch(true); break;
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
      const tabs = ["important", "other", "newsletters", "notifications"];
      const idx = tabs.indexOf(activeTab());
      if (e.shiftKey) {
        setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
      } else {
        setActiveTab(tabs[(idx + 1) % tabs.length]);
      }
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

  onMount(() => document.addEventListener("keydown", handleKeyDown));
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
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
          <Show when={!openThread() && !showCompose()}>
            <div class="flex items-center gap-0 px-20 pb-0" data-tauri-drag-region>
              <For each={[
                { id: "important", label: "Important", count: 4 },
                { id: "other", label: "Other", count: 12 },
                { id: "newsletters", label: "Newsletters", count: 8 },
                { id: "notifications", label: "Notifications", count: 5 },
              ]}>
                {(tab, i) => (
                  <button
                    onClick={() => setActiveTab(tab.id)}
                    class={`relative py-2.5 text-[13px] transition-colors ${i() === 0 ? "pr-3" : "px-3"} ${
                      activeTab() === tab.id
                        ? "text-zinc-900 font-medium"
                        : "text-zinc-400 hover:text-zinc-600"
                    }`}
                  >
                    {tab.label}
                    <span class={`ml-1 text-[11px] tabular-nums ${
                      activeTab() === tab.id ? "text-zinc-400" : "text-zinc-400/50"
                    }`}>{tab.count}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex-1 overflow-hidden">
          <Show when={showCompose()} fallback={
            <Show when={openThread()} fallback={
              <Inbox
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
                    <ContactSidebar threadId={thread().id} />
                  </div>
                </div>
              )}
            </Show>
          }>
            <ComposeView onClose={() => setShowCompose(false)} />
          </Show>
        </div>
      </div>

      {/* ── Overlays ── */}
      <Show when={showSearch()}>
        <SearchOverlay
          onClose={() => setShowSearch(false)}
          onSelectThread={(id) => {
            const thread = MOCK_THREADS.find((t) => t.id === id);
            if (thread) selectAndOpen(thread.id);
          }}
        />
      </Show>
      <Show when={showCommandBar()}>
        <CommandBar onClose={() => setShowCommandBar(false)} onCommand={handleCommand} />
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

const MOCK_CONTACTS: Record<string, { name: string; title: string; location: string; emails: { subject: string; date: string }[]; links: { label: string; url: string }[] }> = {
  "1": {
    name: "Vercel",
    title: "Deployment Notifications",
    location: "",
    emails: [
      { subject: "Failed preview deployment on team...", date: "Today" },
      { subject: "3 domains need configuration...", date: "Today" },
    ],
    links: [{ label: "vercel.com", url: "#" }],
  },
  "5": {
    name: "Support Team",
    title: "Customer Support",
    location: "",
    emails: [
      { subject: "can't access billing page", date: "Apr 2" },
    ],
    links: [],
  },
  "9": {
    name: "Google",
    title: "Account Security",
    location: "",
    emails: [
      { subject: "Security alert", date: "Apr 2" },
      { subject: "Security alert for sahin@zestral.ai", date: "Apr 2" },
    ],
    links: [{ label: "myaccount.google.com", url: "#" }],
  },
};

function ContactSidebar(props: { threadId: string }) {
  const thread = () => MOCK_THREADS.find((t) => t.id === props.threadId);
  const contact = () => MOCK_CONTACTS[props.threadId] ?? {
    name: thread()?.fromName ?? "Unknown",
    title: thread()?.fromEmail ?? "",
    location: "",
    emails: [],
    links: [],
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
