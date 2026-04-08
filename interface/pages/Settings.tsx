import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface Account {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
  isActive: boolean;
}

interface SettingsProps {
  onBack: () => void;
  onAccountsChanged?: () => void;
  onNewAccount?: (accountId: string) => void;
}

type Section = "accounts" | "shortcuts";

const NAV: { id: Section; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "shortcuts", label: "Shortcuts" },
];

export default function Settings(props: SettingsProps) {
  const [section, setSection] = createSignal<Section>("accounts");

  return (
    <div class="h-full flex flex-col">
      {/* Toolbar */}
      <div class="flex items-center gap-3 px-20 pt-5 pb-4">
        <button onClick={props.onBack} class="text-zinc-400 hover:text-zinc-600 transition-colors cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <h1 class="text-[16px] font-medium text-zinc-800">Settings</h1>
        <span class="text-[12px] text-zinc-400 ml-auto">Esc to go back</span>
      </div>

      {/* Body */}
      <div class="flex-1 flex overflow-hidden px-20 pb-8">
        {/* Left nav */}
        <nav class="w-44 flex-shrink-0 pr-6 space-y-0.5">
          <For each={NAV}>
            {(item) => (
              <button
                onClick={() => setSection(item.id)}
                class={`w-full text-left px-3 py-1.5 rounded-md text-[13px] transition-colors cursor-pointer ${
                  section() === item.id
                    ? "bg-zinc-100 text-zinc-900 font-medium"
                    : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {item.label}
              </button>
            )}
          </For>
        </nav>

        {/* Content */}
        <div class="flex-1 min-w-0 overflow-y-auto">
          <Show when={section() === "accounts"}>
            <AccountsSection onAccountsChanged={props.onAccountsChanged} onNewAccount={props.onNewAccount} />
          </Show>
          <Show when={section() === "shortcuts"}>
            <ShortcutsSection />
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ── Section components ── */

function SectionTitle(props: { title: string; description?: string }) {
  return (
    <div class="mb-5">
      <h2 class="text-[15px] font-medium text-zinc-800">{props.title}</h2>
      <Show when={props.description}>
        <p class="text-[13px] text-zinc-400 mt-0.5">{props.description}</p>
      </Show>
    </div>
  );
}

function AccountsSection(props: { onAccountsChanged?: () => void; onNewAccount?: (accountId: string) => void }) {
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [adding, setAdding] = createSignal(false);

  const fetchAccounts = async () => {
    try {
      const result = await invoke<Account[]>("get_accounts");
      setAccounts(result);
    } catch (e) {
      console.error("Failed to fetch accounts:", e);
    } finally {
      setLoading(false);
    }
  };

  const disconnectAccount = async (accountId: string) => {
    try {
      await invoke("disconnect_account", { accountId });
      setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      props.onAccountsChanged?.();
    } catch (e) {
      console.error("Failed to disconnect account:", e);
    }
  };

  const addAccount = async () => {
    setAdding(true);
    try {
      const beforeIds = new Set((await invoke<Account[]>("get_accounts")).map((a) => a.id));
      await invoke("start_oauth_flow");
      await fetchAccounts();
      props.onAccountsChanged?.();
      // Trigger split setup only for a genuinely new account
      const newAccount = accounts().find((a) => !beforeIds.has(a.id));
      if (newAccount) {
        props.onNewAccount?.(newAccount.id);
      }
    } catch (e) {
      console.error("Failed to add account:", e);
    } finally {
      setAdding(false);
    }
  };

  const getInitials = (account: Account): string => {
    const name = account.displayName || account.email.split("@")[0];
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  };

  onMount(fetchAccounts);

  return (
    <div>
      <SectionTitle title="Accounts" description="Connected email accounts" />
      <Show when={!loading()} fallback={
        <div class="text-[13px] text-zinc-400">Loading accounts...</div>
      }>
        <div class="space-y-2">
          <For each={accounts()}>
            {(account) => (
              <div class="border border-zinc-200 rounded-lg p-4 flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-[12px] font-medium text-zinc-500">
                    {getInitials(account)}
                  </div>
                  <div>
                    <div class="text-[13px] text-zinc-700 font-medium">{account.email}</div>
                    <div class="text-[12px] text-zinc-400">
                      {account.provider.charAt(0).toUpperCase() + account.provider.slice(1)} · Connected
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => disconnectAccount(account.id)}
                  class="text-[12px] text-zinc-400 hover:text-red-500 transition-colors cursor-pointer"
                >
                  Disconnect
                </button>
              </div>
            )}
          </For>
        </div>
        <Show when={accounts().length === 0}>
          <div class="text-[13px] text-zinc-400 mb-3">No accounts connected</div>
        </Show>
      </Show>
      <button
        onClick={addAccount}
        disabled={adding()}
        class="mt-4 text-[13px] text-zinc-500 hover:text-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
      >
        {adding() ? "Connecting..." : "+ Add account"}
      </button>
    </div>
  );
}

function ShortcutsSection() {
  const shortcuts = [
    { keys: "J / K", action: "Navigate up / down" },
    { keys: "Enter", action: "Open conversation" },
    { keys: "Escape", action: "Go back" },
    { keys: "C", action: "Compose new email" },
    { keys: "R", action: "Reply" },
    { keys: "⌘ R", action: "Reply all" },
    { keys: "E", action: "Archive" },
    { keys: "/", action: "Search" },
    { keys: "⌘ K", action: "Command bar" },
    { keys: "Tab", action: "Next split" },
    { keys: "⇧ Tab", action: "Previous split" },
    { keys: "H", action: "Set reminder" },
    { keys: "?", action: "Show all shortcuts" },
    { keys: "G I", action: "Go to Inbox" },
    { keys: "G E", action: "Go to Done" },
    { keys: "G T", action: "Go to Sent" },
    { keys: "G D", action: "Go to Drafts" },
    { keys: "G B", action: "Go to Bin" },
    { keys: "G S", action: "Go to Starred" },
    { keys: "G A", action: "Go to All Mail" },
    { keys: "G !", action: "Go to Spam" },
  ];

  return (
    <div>
      <SectionTitle title="Keyboard Shortcuts" description="All available keyboard shortcuts" />
      <div class="space-y-0">
        <For each={shortcuts}>
          {(s) => (
            <div class="flex items-center justify-between py-2.5 border-b border-zinc-100">
              <span class="text-[13px] text-zinc-700">{s.action}</span>
              <kbd class="text-[11px] text-zinc-500 bg-zinc-50 border border-zinc-200 px-2 py-0.5 rounded font-mono">
                {s.keys}
              </kbd>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
