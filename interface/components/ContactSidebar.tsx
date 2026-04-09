import { For, Show } from "solid-js";
import type { ThreadRow } from "../pages/Inbox";

export default function ContactSidebar(props: { threadId: string; threads: ThreadRow[] }) {
  const thread = () => props.threads.find((t) => t.id === props.threadId);

  // Build contact from thread data — other threads from same sender
  const contact = () => {
    const t = thread();
    const name = t?.fromName ?? "Unknown";
    const email = t?.fromEmail ?? "";
    const senderThreads = props.threads
      .filter((th) => th.fromEmail === email && th.id !== props.threadId)
      .slice(0, 5)
      .map((th) => ({ subject: th.subject, date: th.date }));
    return { name, title: email, location: "", emails: senderThreads, links: [] as { label: string; url: string }[] };
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
