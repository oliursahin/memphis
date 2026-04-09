import { createSignal, createEffect, For, Show } from "solid-js";
import type { AppAccount, MailboxDef } from "../App";
import type { SplitConfig } from "../pages/SplitSetup";

interface SidebarProps {
  accounts: () => AppAccount[];
  activeAccountId: () => string | null;
  activeAccount: () => AppAccount | undefined;
  avatarFailed: () => boolean;
  onAvatarError: () => void;
  splits: () => SplitConfig[];
  activeTab: () => string;
  threadCounts: () => Record<string, number>;
  onLoadSplit: (splitId: string) => void;
  activeMailbox: () => string | null;
  onOpenMailbox: (id: string) => void;
  mailboxDefs: readonly MailboxDef[];
  isInboxZero: () => boolean;
  onCollapse: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const iz = () => props.isInboxZero();
  const [menuOpenFor, setMenuOpenFor] = createSignal<string | null>(null);
  const [menuTop, setMenuTop] = createSignal(0);

  // Close dropdown when navigating away (e.g. via keyboard shortcut)
  createEffect(() => { props.activeMailbox(); setMenuOpenFor(null); });
  const [hoveredAcct, setHoveredAcct] = createSignal<string | null>(null);

  return (
    <aside
      class={`w-56 flex-shrink-0 flex flex-col select-none relative z-20 transition-colors ${
        iz() ? "" : "bg-[#FDFDFD] border-r border-zinc-200"
      }`}
    >
      {/* ── Top bar ── */}
      <div class="h-12 flex-shrink-0 flex items-end justify-end px-3 pb-2" data-tauri-drag-region>
        <span
          onClick={props.onCollapse}
          class={`cursor-pointer ${iz() ? "text-white/40 hover:text-white/70" : "text-zinc-500 hover:text-zinc-600"}`}
        >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="1.5" y="3" width="15" height="12" rx="1.5" />
              <line x1="7" y1="3" x2="7" y2="15" />
            </svg>
          </span>
      </div>

      <div class="flex-1 w-full flex flex-col overflow-y-auto">

        {/* ── Morphis ── */}
        <div
          class={`px-10 py-1.5 pb-3 text-[13px] font-medium ${
            iz() ? "text-white/50" : "text-zinc-500"
          }`}
        >
          morphis
        </div>

        {/* ── Active account + splits (single workspace) ── */}
        <Show when={props.activeAccount()}>
          {(account) => {
            const domain = () => account().email.split("@")[1] || account().email;
            return (
              <div class="mt-2">
                {/* Workspace heading with ≡ menu */}
                <div
                  class={`flex items-center justify-between px-10 py-1.5 text-[13px] font-medium ${
                    iz() ? "text-white" : "text-zinc-900"
                  }`}
                  onMouseEnter={() => setHoveredAcct(account().id)}
                  onMouseLeave={() => setHoveredAcct((v) => v === account().id ? null : v)}
                >
                  <span class="truncate">{domain()}</span>
                  <div class="relative">
                    <span
                      on:click={(e: MouseEvent) => { e.stopPropagation(); setMenuTop((e.currentTarget as HTMLElement).getBoundingClientRect().top); setMenuOpenFor((v) => v === account().id ? null : account().id); }}
                      class={`cursor-pointer text-[18px] transition-opacity ${
                        iz() ? "text-white/30 hover:text-white/60" : "text-zinc-500 hover:text-zinc-600"
                      }`}
                      style={{ opacity: hoveredAcct() === account().id || menuOpenFor() === account().id ? 1 : 0 }}
                    >≡</span>
                    <Show when={menuOpenFor() === account().id}>
                      <div class="fixed inset-0 z-40" on:click={() => setMenuOpenFor(null)} />
                      <div class={`fixed z-50 w-40 border py-1.5 ${
                        iz() ? "bg-black/90 border-white/10" : "bg-[#FDFDFD] border-zinc-200"
                      }`} style={{ left: "14rem", top: `${menuTop()}px` }}
                      >
                        <For each={props.mailboxDefs}>
                          {(mb) => {
                            const shortcutKey: Record<string, string> = { done: "E", sent: "T", drafts: "D", bin: "B", spam: "!", starred: "*" };
                            return (
                              <div
                                on:click={(e: MouseEvent) => { e.stopPropagation(); props.onOpenMailbox(mb.id); setMenuOpenFor(null); }}
                                class={`flex items-center justify-between px-4 py-1.5 text-[13px] font-medium cursor-pointer transition-colors ${
                                  props.activeMailbox() === mb.id
                                    ? iz() ? "text-white" : "text-zinc-900"
                                    : iz() ? "text-zinc-300 hover:text-zinc-100" : "text-zinc-500 hover:text-zinc-800"
                                }`}
                              >
                                <span>{mb.label}</span>
                                <Show when={shortcutKey[mb.id]}>
                                  <kbd class={`text-[10px] font-mono ml-3 ${iz() ? "text-white/30" : "text-zinc-400"}`}>
                                    G {shortcutKey[mb.id]}
                                  </kbd>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>

                {/* Splits for active account only */}
                <For each={props.splits()}>
                  {(split) => {
                    const isSplitActive = () => props.activeTab() === split.id && !props.activeMailbox();
                    const count = () => props.threadCounts()[split.id] ?? 0;
                    return (
                      <div
                        onClick={() => props.onLoadSplit(split.id)}
                        class={`flex items-center justify-between pl-10 pr-7 py-1 cursor-pointer text-[13px] font-medium ${
                          isSplitActive()
                            ? iz() ? "text-white" : "text-zinc-900"
                            : iz() ? "text-white/50 hover:text-white/70" : "text-zinc-500 hover:text-zinc-700"
                        }`}
                      >
                        <span class="truncate">{split.name}</span>
                        <Show when={count() > 0}>
                          <span class={`text-[11px] tabular-nums flex-shrink-0 ${
                            iz() ? "text-white/40" : "text-zinc-400"
                          }`}>
                            {count()}
                          </span>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            );
          }}
        </Show>

        <div class="flex-1" />
      </div>

    </aside>
  );
}
