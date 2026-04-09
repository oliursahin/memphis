import { Show } from "solid-js";
import type { SplitConfig } from "../pages/SplitSetup";
import type { AppAccount, MailboxDef } from "../App";

interface HeaderBarProps {
  activeAccount: () => AppAccount | undefined;
  activeTab: () => string;
  activeMailbox: () => string | null;
  openThread: () => { id: string; subject: string } | null;
  showCompose: () => boolean;
  showSettings: () => boolean;
  splits: () => SplitConfig[];
  mailboxDefs: readonly MailboxDef[];
  onBack: () => void;
  isInboxZero: () => boolean;
  sidebarCollapsed: () => boolean;
  onToggleSidebar: () => void;
}

export default function HeaderBar(props: HeaderBarProps) {
  const iz = () => props.isInboxZero();

  const accountPrefix = () => {
    const email = props.activeAccount()?.email ?? "";
    return email.split("@")[0] || email;
  };

  // Current view name (split, mailbox, compose, settings)
  const viewName = () => {
    if (props.showSettings()) return "Settings";
    if (props.showCompose()) return "Compose";
    const mailbox = props.activeMailbox();
    if (mailbox) {
      const mbDef = props.mailboxDefs.find((m) => m.id === mailbox);
      return mbDef?.label ?? mailbox;
    }
    const split = props.splits().find((s) => s.id === props.activeTab());
    return split?.name ?? "Inbox";
  };

  const thread = () => props.openThread();
  const hasBack = () => !!thread() || props.showCompose() || props.showSettings();

  return (
    <div class="flex-shrink-0">
      <div class={`h-12 flex items-center px-20 border-b ${iz() ? "border-white/10" : "bg-[#FDFDFD] border-zinc-200"}`} data-tauri-drag-region>
        {/* Sidebar toggle — shows when collapsed */}
        <Show when={props.sidebarCollapsed()}>
          <span
            onClick={props.onToggleSidebar}
            class={`mr-3 cursor-pointer ${iz() ? "text-white/40 hover:text-white/70" : "text-zinc-500 hover:text-zinc-600"}`}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="1.5" y="3" width="15" height="12" rx="1.5" />
              <line x1="7" y1="3" x2="7" y2="15" />
            </svg>
          </span>
        </Show>

        <Show when={hasBack()}>
          <span
            onClick={props.onBack}
            class={`mr-2 cursor-pointer transition-colors ${
              iz() ? "text-white/30 hover:text-white/60" : "text-zinc-500 hover:text-zinc-600"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 12L6 8l4-4" />
            </svg>
          </span>
        </Show>

        <span class={`text-[14px] truncate ${iz() ? "text-white/60" : "text-zinc-600"}`}>
          {accountPrefix()}/{viewName()}
        </span>

        <Show when={!thread() && !props.showCompose() && !props.showSettings() && !props.activeMailbox()}>
          <span class={`ml-3 text-[12px] opacity-60 ${iz() ? "text-white/40" : "text-zinc-500"}`}>
            <kbd class={`px-1 py-0.5 rounded text-[11px] font-mono ${iz() ? "bg-white/10 text-white/50" : "bg-zinc-100 text-zinc-500"}`}>Tab</kbd> next split
          </span>
        </Show>

        <div class="flex-1" />

        <Show when={thread()}>
          <div class="flex items-center gap-3 opacity-60 mr-4">
            <span class={`text-[12px] ${iz() ? "text-white/40" : "text-zinc-500"}`}>
              <kbd class={`px-1 py-0.5 rounded text-[11px] font-mono ${iz() ? "bg-white/10 text-white/50" : "bg-zinc-100 text-zinc-500"}`}>R</kbd> reply
            </span>
            <span class={`text-[12px] ${iz() ? "text-white/40" : "text-zinc-500"}`}>
              <kbd class={`px-1 py-0.5 rounded text-[11px] font-mono ${iz() ? "bg-white/10 text-white/50" : "bg-zinc-100 text-zinc-500"}`}>E</kbd> archive
            </span>
            <span class={`text-[12px] ${iz() ? "text-white/40" : "text-zinc-500"}`}>
              <kbd class={`px-1 py-0.5 rounded text-[11px] font-mono ${iz() ? "bg-white/10 text-white/50" : "bg-zinc-100 text-zinc-500"}`}>Esc</kbd> back
            </span>
          </div>
        </Show>

      </div>
    </div>
  );
}
