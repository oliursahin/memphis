import { createSignal, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface SplitConfig {
  id: string;
  name: string;
  gmailLabelId?: string;
  query?: string;
}

interface SplitSetupProps {
  onComplete: (splits: SplitConfig[]) => void;
}

// Smart splits — some use labels, some use queries
const SUGGESTED_SPLITS: { id: string; name: string; query: string }[] = [
  { id: "important", name: "Important", query: "category:primary" },
  { id: "calendar", name: "Calendar", query: "{filename:ics from:calendar-notification@google.com}" },
  { id: "github", name: "GitHub", query: "from:notifications@github.com" },
  { id: "others", name: "Others", query: "*" },
];

export default function SplitSetup(props: SplitSetupProps) {
  const [labels, setLabels] = createSignal<GmailLabel[]>([]);
  const [loading, setLoading] = createSignal(true);
    const [selected, setSelected] = createSignal<Set<string>>(new Set(["important", "calendar", "github", "others"]));
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const result = await invoke<GmailLabel[]>("list_labels");
      setLabels(result);
    } catch (e: any) {
      setError(typeof e === "string" ? e : "Failed to load labels");
    } finally {
      setLoading(false);
    }
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const systemLabels = () => SUGGESTED_SPLITS;

  const userLabels = () =>
    labels().filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name));

  const finish = () => {
    const sel = selected();
    const result: SplitConfig[] = [];
    for (const id of sel) {
      const suggested = SUGGESTED_SPLITS.find((s) => s.id === id);
      if (suggested) {
        result.push({ id, name: suggested.name, query: suggested.query });
      } else {
        // User-created label — use label ID as a query filter
        const label = labels().find((l) => l.id === id);
        if (label) result.push({ id, name: label.name, query: `label:${label.name}` });
      }
    }
    props.onComplete(result);
  };

  return (
    <div class="h-screen w-screen bg-white flex items-center justify-center" data-tauri-drag-region>
      <div class="w-full max-w-md">
        <h1 class="text-[20px] font-semibold text-zinc-900">Set up your splits</h1>
        <p class="text-[13px] text-zinc-400 mt-1">
          Pick which labels become inbox splits. You can change this later in settings.
        </p>

        <Show when={!loading()} fallback={
          <div class="mt-8 text-[13px] text-zinc-400">Loading labels…</div>
        }>
          <Show when={!error()} fallback={
            <div class="mt-8 text-[13px] text-red-500">{error()}</div>
          }>
            {/* Suggested splits */}
            <div class="mt-6">
              <div class="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Suggested</div>
              <div class="space-y-1">
                <For each={systemLabels()}>
                  {(label) => (
                    <button
                      onClick={() => toggle(label.id)}
                      class={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                        selected().has(label.id) ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
                      }`}
                    >
                      <span class="text-[13px]">{label.name}</span>
                      <Show when={selected().has(label.id)}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-600">
                          <path d="M3.5 8l3 3 6-6" />
                        </svg>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* User labels */}
            <Show when={userLabels().length > 0}>
              <div class="mt-5">
                <div class="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">Your labels</div>
                <div class="space-y-1 max-h-48 overflow-y-auto">
                  <For each={userLabels()}>
                    {(label) => (
                      <button
                        onClick={() => toggle(label.id)}
                        class={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                          selected().has(label.id) ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
                        }`}
                      >
                        <span class="text-[13px]">{label.name}</span>
                        <Show when={selected().has(label.id)}>
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-600">
                            <path d="M3.5 8l3 3 6-6" />
                          </svg>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </Show>

        <button
          onClick={finish}
          disabled={selected().size === 0}
          class="mt-8 w-full py-2.5 rounded-lg bg-zinc-900 text-white text-[14px] font-medium hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Continue with {selected().size} split{selected().size !== 1 ? "s" : ""}
        </button>

        <button
          onClick={() => props.onComplete([])}
          class="mt-2 w-full py-2 text-[13px] text-zinc-400 hover:text-zinc-600 transition-colors cursor-pointer"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
