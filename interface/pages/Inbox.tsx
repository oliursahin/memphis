import { For, Show } from "solid-js";

export interface ThreadRow {
  id: string;
  gmailThreadId?: string;
  subject: string;
  snippet: string;
  fromName: string;
  fromEmail: string;
  date: string;
  isRead: boolean;
  messageCount: number;
}

interface InboxProps {
  threads: ThreadRow[];
  loading: boolean;
  onOpenThread: (thread: { id: string; subject: string }) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onArchive: (threadId: string) => void;
  onTrash: (threadId: string) => void;
}

export default function Inbox(props: InboxProps) {

  return (
    <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
      <Show when={!props.loading} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
      }>
      <Show when={props.threads.length > 0} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Inbox zero</div>
      }>
        <For each={props.threads}>
          {(thread) => (
                <div
                  class={`group flex items-center gap-3 px-20 py-2.5 cursor-pointer ${
                    props.selectedId === thread.id
                      ? "bg-zinc-100/60"
                      : ""
                  }`}
                  onClick={() => {
                    props.onSelect(thread.id);
                    props.onOpenThread({ id: thread.id, subject: thread.subject });
                  }}
                >
                  {/* Sender */}
                  <div class="w-40 flex-shrink-0 truncate">
                    <span class={`text-[13px] ${!thread.isRead ? "font-semibold text-zinc-900" : "text-zinc-500"}`}>
                      {thread.fromName}
                    </span>
                    <Show when={thread.messageCount > 1}>
                      <span class="text-[11px] text-zinc-400 ml-1.5">{thread.messageCount}</span>
                    </Show>
                  </div>

                  {/* Subject */}
                  <div class="flex-1 min-w-0 truncate">
                    <span class={`text-[13px] ${!thread.isRead ? "font-medium text-zinc-800" : "text-zinc-400"}`}>
                      {thread.subject}
                    </span>
                  </div>

                  {/* Date / hover actions — stacked in same space to prevent layout shift */}
                  <div class="relative w-[140px] flex-shrink-0 pl-3">
                    <div class="flex justify-end text-[12px] text-zinc-400 tabular-nums group-hover:invisible">
                      {thread.date}
                    </div>
                    <div class="absolute inset-0 flex items-center justify-end invisible group-hover:visible" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => props.onArchive(thread.id)} class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="Done (e)">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3.5 8l3 3 6-6" />
                      </svg>
                    </button>
                    <button onClick={() => props.onTrash(thread.id)} class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="Trash (#)">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4" />
                      </svg>
                    </button>
                    </div>
                  </div>
                </div>
          )}
        </For>
      </Show>
      </Show>
    </div>
  );
}
