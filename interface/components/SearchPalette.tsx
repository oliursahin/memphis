import { createSignal, For, Show } from "solid-js";

interface SearchOverlayProps {
  onClose: () => void;
  onSelectThread: (id: string) => void;
}

interface SearchResult {
  id: string;
  fromName: string;
  subject: string;
  snippet: string;
  date: string;
}

const ALL_RESULTS: SearchResult[] = [
  { id: "1", fromName: "Vercel", subject: "Failed preview deployment on team 'Oliur Sahin's projects'", snippet: "A deployment has failed...", date: "5:58 PM" },
  { id: "5", fromName: "me .. me", subject: "can't access billing page", snippet: "Hi, I can't access...", date: "Apr 2" },
  { id: "6", fromName: "Dan Koe", subject: "I'm begging you to write more essays", snippet: "The world needs more...", date: "Apr 2" },
  { id: "8", fromName: "Paul Sangiki-Ferrierie", subject: "cubic March update: #1 on Code Review Benchmark", snippet: "We're excited to share...", date: "Apr 2" },
  { id: "9", fromName: "Google", subject: "Security alert", snippet: "A new sign-in was detected...", date: "Apr 2" },
  { id: "12", fromName: "Superhuman", subject: "Meet Superhuman Go, the shortcut to done", snippet: "Introducing the fastest way...", date: "Apr 1" },
];

export default function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const results = () => {
    const q = query().toLowerCase();
    if (!q) return [];
    return ALL_RESULTS.filter(
      (r) =>
        r.subject.toLowerCase().includes(q) ||
        r.fromName.toLowerCase().includes(q) ||
        r.snippet.toLowerCase().includes(q)
    );
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results().length > 0) {
      e.preventDefault();
      props.onSelectThread(results()[selectedIndex()].id);
      props.onClose();
    } else if (e.key === "Escape") {
      props.onClose();
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={props.onClose}>
      <div class="absolute inset-0 bg-black/20 backdrop-blur-sm" />

      <div
        class="relative w-full max-w-[480px] bg-white/40 backdrop-blur-2xl backdrop-saturate-150 border border-white/30 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div class="flex items-center gap-3 px-4 py-3 border-b border-black/[0.06]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-black/30 flex-shrink-0">
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
            class="flex-1 bg-transparent text-[14px] text-black/80 outline-none placeholder:text-black/30"
            placeholder="Search emails..."
            autofocus
          />
          <kbd class="text-[10px] text-black/30 bg-black/[0.04] border border-black/[0.06] px-1.5 py-0.5 rounded-md font-mono">Esc</kbd>
        </div>

        {/* Results */}
        <Show when={results().length > 0}>
          <div class="max-h-[40vh] overflow-y-auto py-1">
            <For each={results()}>
              {(result, index) => (
                <button
                  class={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    selectedIndex() === index()
                      ? "bg-black/[0.04]"
                      : "hover:bg-black/[0.03]"
                  }`}
                  onClick={() => {
                    props.onSelectThread(result.id);
                    props.onClose();
                  }}
                >
                  <div class="w-6 h-6 rounded-full bg-black/[0.06] flex items-center justify-center text-[10px] font-medium text-black/40 flex-shrink-0">
                    {result.fromName[0]?.toUpperCase()}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-baseline gap-2">
                      <span class="text-[13px] text-black/70 font-medium">{result.fromName}</span>
                      <span class="text-[11px] text-black/30">{result.date}</span>
                    </div>
                    <div class="text-[12px] text-black/40 truncate">{result.subject}</div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={query().length > 0 && results().length === 0}>
          <div class="px-4 py-6 text-center text-[13px] text-black/35">
            No results for "{query()}"
          </div>
        </Show>

        <Show when={query().length === 0}>
          <div class="px-4 py-6 text-center text-[13px] text-black/35">
            Start typing to search...
          </div>
        </Show>
      </div>
    </div>
  );
}
