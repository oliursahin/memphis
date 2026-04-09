import { For, Show } from "solid-js";
import type { ThreadRow } from "./Inbox";

export default function MailboxView(props: {
  label: string;
  emptyText: string;
  threads: ThreadRow[];
  loading: boolean;
  onOpenThread: (thread: ThreadRow) => void;
  onCompose?: () => void;
}) {
  return (
    <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
      <Show when={!props.loading} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-500">Loading…</div>
      }>
      <Show when={props.threads.length > 0} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-500">{props.emptyText}</div>
      }>
        <For each={props.threads}>
          {(thread) => (
            <div
              class="group flex items-center gap-3 px-16 py-2.5 cursor-pointer hover:bg-zinc-50"
              onClick={() => {
                if (thread.labelIds?.includes("DRAFT")) {
                  props.onCompose?.();
                  return;
                }
                props.onOpenThread(thread);
              }}
            >
              <div class="w-40 flex-shrink-0 truncate">
                <Show when={thread.labelIds?.includes("DRAFT")}>
                  <span class="text-[13px] font-medium text-green-600 mr-1">Draft</span>
                </Show>
                <span class="text-[13px] text-zinc-600">
                  {thread.labelIds?.includes("DRAFT") ? `to ${thread.fromName}` : thread.fromName}
                </span>
              </div>
              <div class="flex-1 min-w-0 truncate">
                <span class="text-[13px] text-zinc-500">{thread.subject}</span>
              </div>
              <div class="text-[12px] text-zinc-500 tabular-nums">{thread.date}</div>
            </div>
          )}
        </For>
      </Show>
      </Show>
    </div>
  );
}
