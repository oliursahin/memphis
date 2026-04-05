import { createSignal, For } from "solid-js";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  section: string;
  icon?: string;
}

interface CommandBarProps {
  onClose: () => void;
  onCommand: (id: string) => void;
}

const COMMANDS: Command[] = [
  // Actions — email operations
  { id: "compose", label: "Compose new email", shortcut: "C", section: "Actions", icon: "edit" },
  { id: "reply", label: "Reply", shortcut: "R", section: "Actions", icon: "reply" },
  { id: "reply-all", label: "Reply all", shortcut: "⇧R", section: "Actions", icon: "reply" },
  { id: "forward", label: "Forward", shortcut: "F", section: "Actions", icon: "forward" },
  { id: "archive", label: "Archive", shortcut: "E", section: "Actions", icon: "archive" },
  { id: "mark-done", label: "Mark as done", shortcut: "E", section: "Actions", icon: "done" },
  { id: "mark-unread", label: "Mark as unread", shortcut: "U", section: "Actions", icon: "mail" },
  { id: "star", label: "Star / unstar", shortcut: "S", section: "Actions", icon: "star" },
  { id: "trash", label: "Move to trash", shortcut: "#", section: "Actions", icon: "trash" },
  { id: "spam", label: "Report spam", shortcut: "!", section: "Actions", icon: "spam" },
  { id: "search", label: "Search emails", shortcut: "/", section: "Actions", icon: "search" },
  // Organize — splits, labels
  { id: "create-split", label: "Create new split", section: "Organize", icon: "split" },
  { id: "edit-splits", label: "Edit splits", section: "Organize", icon: "split" },
  { id: "apply-label", label: "Apply label to conversation", shortcut: "L", section: "Organize", icon: "label" },
  { id: "remove-label", label: "Remove label", section: "Organize", icon: "label" },
  { id: "move-to", label: "Move to…", shortcut: "V", section: "Organize", icon: "move" },
  { id: "block-sender", label: "Block sender", section: "Organize", icon: "block" },
  { id: "unsubscribe", label: "Unsubscribe", section: "Organize", icon: "unsubscribe" },
  // Navigation
  { id: "inbox", label: "Go to Inbox", shortcut: "G I", section: "Navigation", icon: "inbox" },
  { id: "sent", label: "Go to Sent", shortcut: "G S", section: "Navigation", icon: "send" },
  { id: "drafts", label: "Go to Drafts", shortcut: "G D", section: "Navigation", icon: "file" },
  { id: "starred", label: "Go to Starred", shortcut: "G T", section: "Navigation", icon: "star" },
  { id: "done", label: "Go to Done", section: "Navigation", icon: "done" },
  { id: "all", label: "Go to All Mail", section: "Navigation", icon: "mail" },
  { id: "spam-folder", label: "Go to Spam", section: "Navigation", icon: "spam" },
  { id: "trash-folder", label: "Go to Trash", section: "Navigation", icon: "trash" },
  { id: "settings", label: "Go to Settings", section: "Navigation", icon: "settings" },
  // Other
  { id: "shortcuts", label: "Show keyboard shortcuts", shortcut: "?", section: "Other", icon: "help" },
  { id: "account", label: "Log out", section: "Other", icon: "account" },
  { id: "download-eml", label: "Download as .eml", section: "Other", icon: "download" },
];

function CommandIcon(props: { name: string }) {
  const icons: Record<string, () => any> = {
    inbox: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
      </svg>
    ),
    send: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    ),
    file: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
      </svg>
    ),
    mail: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" />
      </svg>
    ),
    settings: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    edit: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
    search: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    help: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    reply: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 00-4-4H4" />
      </svg>
    ),
    archive: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    ),
    forward: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 014-4h12" />
      </svg>
    ),
    done: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    star: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    trash: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      </svg>
    ),
    spam: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
    split: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" />
      </svg>
    ),
    label: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" />
      </svg>
    ),
    move: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
    ),
    block: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    ),
    unsubscribe: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18.36 6.64A9 9 0 015.64 19.36 9 9 0 0118.36 6.64z" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
    account: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
      </svg>
    ),
    download: () => (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  };

  const Icon = icons[props.name];
  return Icon ? <Icon /> : null;
}

export default function CommandBar(props: CommandBarProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const filtered = () => {
    const q = query().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered().length > 0) {
      e.preventDefault();
      props.onCommand(filtered()[selectedIndex()].id);
      props.onClose();
    } else if (e.key === "Escape") {
      props.onClose();
    }
  };

  const grouped = () => {
    const groups: { section: string; items: (Command & { globalIndex: number })[] }[] = [];
    let globalIndex = 0;
    const items = filtered();

    for (const item of items) {
      let group = groups.find((g) => g.section === item.section);
      if (!group) {
        group = { section: item.section, items: [] };
        groups.push(group);
      }
      group.items.push({ ...item, globalIndex });
      globalIndex++;
    }
    return groups;
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={props.onClose}>
      {/* Backdrop */}
      <div class="absolute inset-0 bg-black/20 backdrop-blur-sm" />

      {/* Glassmorphic panel */}
      <div
        class="relative w-full max-w-[480px] bg-white/40 backdrop-blur-2xl backdrop-saturate-150 border border-white/30 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div class="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06]">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-black/30 flex-shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            class="flex-1 bg-transparent text-[14px] text-black/80 outline-none placeholder:text-black/40"
            placeholder="Type a command or search..."
            autofocus
          />
        </div>

        {/* Commands list */}
        <div class="max-h-[40vh] overflow-y-auto py-1">
          <For each={grouped()}>
            {(group) => (
              <div>
                <div class="px-4 pt-3 pb-1">
                  <span class="text-[11px] font-medium text-black/35 tracking-wide">
                    {group.section}
                  </span>
                </div>
                <For each={group.items}>
                  {(cmd) => (
                    <button
                      class={`w-full flex items-center justify-between px-4 py-2 text-left transition-colors ${
                        selectedIndex() === cmd.globalIndex
                          ? "bg-black/[0.04]"
                          : "hover:bg-black/[0.03]"
                      }`}
                      onClick={() => {
                        props.onCommand(cmd.id);
                        props.onClose();
                      }}
                    >
                      <div class="flex items-center gap-3">
                        <span class="text-black/40">
                          {cmd.icon && <CommandIcon name={cmd.icon} />}
                        </span>
                        <span class="text-[13px] text-black/70">{cmd.label}</span>
                      </div>
                      {cmd.shortcut && (
                        <kbd class="text-[10px] text-black/30 bg-black/[0.04] border border-black/[0.06] px-1.5 py-0.5 rounded-md font-mono">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
