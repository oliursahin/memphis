import { createSignal, For, Show } from "solid-js";
import type { AppAccount, MailboxDef } from "../App";
import type { SplitConfig } from "../pages/SplitSetup";

interface SidebarProps {
  accounts: () => AppAccount[];
  activeAccountId: () => string | null;
  activeAccount: () => AppAccount | undefined;
  avatarFailed: () => boolean;
  onAvatarError: () => void;
  onSwitchAccount: (id: string) => void;
  splits: () => SplitConfig[];
  activeTab: () => string;
  threadCounts: () => Record<string, number>;
  onLoadSplit: (splitId: string) => void;
  activeMailbox: () => string | null;
  onOpenMailbox: (id: string) => void;
  mailboxDefs: readonly MailboxDef[];
  onShowSearch: () => void;
  onShowCommandBar: () => void;
  isInboxZero: () => boolean;
  onCollapse: () => void;
  allAccountSplits: () => Record<string, SplitConfig[]>;
}

export default function Sidebar(props: SidebarProps) {
  const iz = () => props.isInboxZero();
  const [menuOpenFor, setMenuOpenFor] = createSignal<string | null>(null);
  const [menuTop, setMenuTop] = createSignal(0);
  const [hoveredAcct, setHoveredAcct] = createSignal<string | null>(null);
  const [collapsedAccts, setCollapsedAccts] = createSignal<Set<string>>(new Set());

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

        {/* ── Scratchpad (commented out) ── */}
        {/* <div
          onClick={() => { props.onOpenMailbox("drafts"); setMenuOpenFor(null); }}
          class={`px-10 py-1.5 pb-3 cursor-pointer text-[13px] font-medium ${
            props.activeMailbox() === "drafts"
              ? iz() ? "text-white" : "text-zinc-900"
              : iz() ? "text-white/50 hover:text-white/70" : "text-zinc-500 hover:text-zinc-700"
          }`}
        >
          Scratchpad
        </div> */}

        {/* ── Morphis ── */}
        <div
          class={`px-10 py-1.5 pb-3 text-[13px] font-medium ${
            iz() ? "text-white/50" : "text-zinc-500"
          }`}
        >
          Morphis
        </div>

        {/* ── Thin line ── */}
        <div class={`mx-7 border-t ${iz() ? "border-white/10" : "border-zinc-200"}`} />

        {/* ── Accounts with splits ── */}
        <div class="mt-2">
          <For each={props.accounts()}>
            {(account) => {
              const isActive = () => account.id === props.activeAccountId();
              const prefix = () => account.email.split("@")[0] || account.email;
              return (
                <>
                  {/* Account row with ≡ menu */}
                  <div
                    class={`flex items-center justify-between px-7 py-1.5 cursor-pointer text-[13px] font-medium ${
                      isActive()
                        ? iz() ? "text-white" : "text-zinc-900"
                        : iz() ? "text-white/60 hover:text-white/80" : "text-zinc-700 hover:text-zinc-900"
                    }`}
                    onClick={() => {
                      if (!isActive()) props.onSwitchAccount(account.id);
                      setCollapsedAccts((prev) => {
                        const next = new Set(prev);
                        if (next.has(account.id)) next.delete(account.id);
                        else next.add(account.id);
                        return next;
                      });
                    }}
                    onMouseEnter={() => setHoveredAcct(account.id)}
                    onMouseLeave={() => setHoveredAcct((v) => v === account.id ? null : v)}
                  >
                    <div class="flex items-center gap-1">
                      <span
                        on:click={(e: MouseEvent) => {
                          e.stopPropagation();
                          setCollapsedAccts((prev) => {
                            const next = new Set(prev);
                            if (next.has(account.id)) next.delete(account.id);
                            else next.add(account.id);
                            return next;
                          });
                        }}
                        class={`cursor-pointer transition-all ${
                          iz() ? "text-white/30 hover:text-white/60" : "text-zinc-500 hover:text-zinc-600"
                        }`}
                        style={{
                          transform: collapsedAccts().has(account.id) ? "rotate(-90deg)" : "rotate(0deg)",
                          opacity: hoveredAcct() === account.id ? 1 : 0,
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4.5 3L7.5 6L4.5 9" />
                        </svg>
                      </span>
                      <span>{prefix()}</span>
                    </div>
                    <div class="relative">
                      <span
                        on:click={(e: MouseEvent) => { e.stopPropagation(); setMenuTop((e.currentTarget as HTMLElement).getBoundingClientRect().top); setMenuOpenFor((v) => v === account.id ? null : account.id); }}
                        class={`cursor-pointer text-[18px] transition-opacity ${
                          iz() ? "text-white/30 hover:text-white/60" : "text-zinc-500 hover:text-zinc-600"
                        }`}
                        style={{ opacity: hoveredAcct() === account.id || menuOpenFor() === account.id ? 1 : 0 }}
                      >≡</span>
                      <Show when={menuOpenFor() === account.id}>
                        <div class="fixed inset-0 z-40" on:click={() => setMenuOpenFor(null)} />
                        <div class={`fixed z-50 w-40 border py-1.5 ${
                          iz() ? "bg-black/90 border-white/10" : "bg-[#FDFDFD] border-zinc-200"
                        }`} style={{ left: "14rem", top: `${menuTop()}px` }}
                        >
                          <For each={props.mailboxDefs}>
                            {(mb) => (
                              <div
                                on:click={(e: MouseEvent) => { e.stopPropagation(); if (!isActive()) props.onSwitchAccount(account.id); props.onOpenMailbox(mb.id); setMenuOpenFor(null); }}
                                class={`px-4 py-1.5 text-[13px] font-medium cursor-pointer transition-colors ${
                                  props.activeMailbox() === mb.id
                                    ? iz() ? "text-white" : "text-zinc-900"
                                    : iz() ? "text-zinc-300 hover:text-zinc-100" : "text-zinc-500 hover:text-zinc-800"
                                }`}
                              >
                                {mb.label}
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>

                  {/* Splits — collapsible per account */}
                  <Show when={!collapsedAccts().has(account.id)}>
                    <For each={isActive() ? props.splits() : (props.allAccountSplits()[account.id] ?? [])}>
                      {(split) => {
                        const isSplitActive = () => isActive() && props.activeTab() === split.id && !props.activeMailbox();
                        const count = () => isActive() ? (props.threadCounts()[split.id] ?? 0) : 0;
                        return (
                          <div
                            onClick={() => {
                              if (!isActive()) props.onSwitchAccount(account.id);
                              props.onLoadSplit(split.id);
                            }}
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
                  </Show>
                </>
              );
            }}
          </For>
        </div>

        <div class="flex-1" />
      </div>
    </aside>
  );
}
