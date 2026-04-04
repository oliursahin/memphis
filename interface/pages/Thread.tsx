import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface Message {
  id: string;
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  date: string;
  bodyHtml: string;
}

interface ThreadDetailResponse {
  id: string;
  subject: string;
  messages: Message[];
}

interface ThreadViewProps {
  threadId: string;
  subject: string;
  onBack: () => void;
  replyOpen?: boolean;
  onReplyOpen?: () => void;
  onReplyClose?: () => void;
}

export default function ThreadView(props: ThreadViewProps) {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [replyBody, setReplyBody] = createSignal("");

  // Fetch thread detail when threadId changes
  createEffect(() => {
    const id = props.threadId;
    setLoading(true);
    setError(null);
    setMessages([]);
    setCollapsed(new Set<string>());

    invoke<ThreadDetailResponse>("get_thread_detail", { threadId: id })
      .then((detail) => {
        setMessages(detail.messages);
        // Collapse all messages except the last one
        if (detail.messages.length > 1) {
          const ids = new Set(detail.messages.slice(0, -1).map((m) => m.id));
          setCollapsed(ids);
        }
      })
      .catch((e) => {
        console.error("Failed to load thread:", e);
        setError(typeof e === "string" ? e : "Failed to load thread");
      })
      .finally(() => setLoading(false));
  });

  const lastMsg = () => {
    const msgs = messages();
    return msgs.length > 0 ? msgs[msgs.length - 1] : null;
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div class="h-full flex flex-col bg-white">
      <div class="flex-1 overflow-y-auto px-20">
        {/* Actions row */}
        <div class="flex items-center mb-4">
          <button
            onClick={props.onBack}
            class="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 12L6 8l4-4" />
            </svg>
          </button>
          <div class="flex-1" />
          <div class="flex items-center gap-1">
            <button class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="Print">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6V2h8v4" /><rect x="2" y="6" width="12" height="6" rx="1" /><path d="M4 12v2h8v-2" />
              </svg>
            </button>
            <button class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="Mark as unread">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
              </svg>
            </button>
            <button class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="Add label">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 4a1 1 0 011-1h4.586a1 1 0 01.707.293l5.414 5.414a1 1 0 010 1.414l-3.586 3.586a1 1 0 01-1.414 0L3.293 8.293A1 1 0 013 7.586V4z" />
                <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
              </svg>
            </button>
            <button class="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors" title="More">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="3" cy="8" r="1" fill="currentColor" />
                <circle cx="8" cy="8" r="1" fill="currentColor" />
                <circle cx="13" cy="8" r="1" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        {/* Subject */}
        <h1 class="text-[20px] font-semibold text-zinc-900 leading-tight">
          {props.subject}
        </h1>

        <div>
          {/* Guide hint */}
          <div class="mt-2 mb-6 flex items-center gap-3 opacity-60">
            <span class="text-[12px] text-zinc-400">
              Hit <kbd class="px-1 py-0.5 rounded bg-zinc-100 text-[11px] font-mono text-zinc-500">R</kbd> to reply
            </span>
            <span class="text-[12px] text-zinc-400">
              <kbd class="px-1 py-0.5 rounded bg-zinc-100 text-[11px] font-mono text-zinc-500">E</kbd> archive
            </span>
            <span class="text-[12px] text-zinc-400">
              <kbd class="px-1 py-0.5 rounded bg-zinc-100 text-[11px] font-mono text-zinc-500">Esc</kbd> back
            </span>
          </div>

          {/* Loading / Error / Messages */}
          <Show when={!loading()} fallback={
            <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading messages…</div>
          }>
            <Show when={!error()} fallback={
              <div class="flex items-center justify-center h-32 text-[13px] text-red-500">{error()}</div>
            }>
              <div class="space-y-5">
                <For each={messages()}>
                  {(msg) => (
                    <MessageBubble
                      message={msg}
                      isCollapsed={collapsed().has(msg.id)}
                      onToggle={() => toggleCollapse(msg.id)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Inline reply */}
          <Show when={props.replyOpen && lastMsg()}>
            <div class="mt-5 border-l-2 border-zinc-300 pl-5">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-[12px] text-zinc-400">To: {lastMsg()!.fromName}</span>
                <span class="text-[12px] text-zinc-400 ml-auto">&lt;{lastMsg()!.fromEmail}&gt;</span>
              </div>
              <textarea
                ref={(el) => setTimeout(() => el.focus(), 0)}
                value={replyBody()}
                onInput={(e) => setReplyBody(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    props.onReplyClose?.();
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    setReplyBody("");
                    props.onReplyClose?.();
                  }
                }}
                placeholder="Write your reply..."
                class="w-full min-h-[120px] text-[14px] text-zinc-800 leading-[1.7] bg-transparent resize-none outline-none placeholder:text-zinc-300"
              />
              <div class="flex items-center gap-3 mt-2 mb-2">
                <span class="text-[11px] text-zinc-400">⌘ Enter to send</span>
                <span class="text-[11px] text-zinc-400">Esc to discard</span>
              </div>
            </div>
          </Show>
        </div>

        <div class="h-8" />
      </div>
    </div>
  );
}

function MessageBubble(props: { message: Message; isCollapsed: boolean; onToggle: () => void }) {
  const msg = () => props.message;
  const [detailsOpen, setDetailsOpen] = createSignal(false);

  // Strip HTML for collapsed preview
  const plainPreview = () => {
    const div = document.createElement("div");
    div.innerHTML = msg().bodyHtml;
    return (div.textContent || "").slice(0, 100);
  };

  // "To me" or "To recipient" — short version
  const toShort = () => {
    const to = msg().to;
    // If it's addressed to a single known user, show "me"
    if (!to || to.includes("@") && to.split(",").length === 1) {
      return "me";
    }
    const parts = to.split(",").map((s) => s.trim());
    if (parts.length === 1) return parts[0].replace(/<[^>]*>/g, "").trim() || "me";
    return `me, +${parts.length - 1} more`;
  };

  return (
    <Show when={!props.isCollapsed} fallback={
      <div
        class="cursor-pointer hover:bg-zinc-50 rounded-lg py-2 px-1 transition-colors"
        onClick={props.onToggle}
      >
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-semibold text-zinc-700 flex-shrink-0">{msg().fromName}</span>
          <span class="text-[12px] text-zinc-400 truncate flex-1">{plainPreview()}</span>
          <span class="text-[12px] text-zinc-400 flex-shrink-0">{msg().date}</span>
        </div>
      </div>
    }>
      <div>
        {/* Sender row: Name  email@address  ·  date */}
        <div class="flex items-baseline gap-2 cursor-pointer" onClick={props.onToggle}>
          <span class="text-[14px] font-semibold text-zinc-900">{msg().fromName}</span>
          <span class="text-[13px] text-zinc-400">{msg().fromEmail}</span>
          <div class="flex-1" />
          <span class="text-[12px] text-zinc-400 flex-shrink-0">{msg().date}</span>
        </div>

        {/* To line — collapsed by default, click chevron to expand */}
        <div class="mt-0.5 flex items-center gap-1">
          <span class="text-[12px] text-zinc-400">To {toShort()}</span>
          <button
            onClick={(e) => { e.stopPropagation(); setDetailsOpen((v) => !v); }}
            class="text-zinc-400 hover:text-zinc-600 transition-colors p-0.5"
            title="Show details"
          >
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
              class={`transition-transform ${detailsOpen() ? "rotate-180" : ""}`}
            >
              <path d="M2.5 3.5L5 6.5L7.5 3.5" />
            </svg>
          </button>
        </div>

        {/* Expanded details: full To + CC */}
        <Show when={detailsOpen()}>
          <div class="mt-1.5 pl-0 space-y-0.5 text-[12px] text-zinc-400">
            <div>
              <span class="text-zinc-500 font-medium">From: </span>
              {msg().fromName} &lt;{msg().fromEmail}&gt;
            </div>
            <div>
              <span class="text-zinc-500 font-medium">To: </span>
              {msg().to}
            </div>
            <Show when={msg().cc}>
              <div>
                <span class="text-zinc-500 font-medium">Cc: </span>
                {msg().cc}
              </div>
            </Show>
            <div>
              <span class="text-zinc-500 font-medium">Date: </span>
              {msg().date}
            </div>
          </div>
        </Show>

        {/* Body — sandboxed iframe for CSS isolation */}
        <div class="mt-4 border-l-2 border-zinc-200 pl-5">
          <EmailBody html={msg().bodyHtml} />
        </div>
      </div>
    </Show>
  );
}

/** Renders sanitized HTML email in a sandboxed iframe with auto-height. */
function EmailBody(props: { html: string }) {
  let iframeRef: HTMLIFrameElement | undefined;
  const [height, setHeight] = createSignal(60);

  const resizeToContent = () => {
    const doc = iframeRef?.contentDocument;
    if (doc?.body) {
      const h = doc.body.scrollHeight;
      if (h > 0) setHeight(h + 4); // small buffer to avoid scrollbar
    }
  };

  createEffect(() => {
    const html = props.html;
    if (!iframeRef) return;

    const doc = iframeRef.contentDocument;
    if (!doc) return;

    doc.open();
    doc.write(`<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:;">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.7; color: #27272a;
    word-break: break-word; overflow-wrap: break-word;
    overflow: hidden;
  }
  a { color: #3b82f6; }
  img { max-width: 100%; height: auto; }
  img[src^="cid:"] { display: none; }
  table { max-width: 100%; font-size: 13px; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; }
  blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid #e4e4e7; color: #71717a; }
  p { margin: 0 0 12px; } p:last-child { margin-bottom: 0; }
</style></head><body>${html}</body></html>`);
    doc.close();

    // Resize after render and again after images load
    setTimeout(resizeToContent, 50);
    setTimeout(resizeToContent, 500);
    setTimeout(resizeToContent, 1500);

    if (doc.body) {
      doc.body.querySelectorAll("img").forEach((img) => {
        if (img.src.startsWith("cid:")) {
          img.remove();
        } else {
          img.addEventListener("load", resizeToContent);
          img.addEventListener("error", () => img.remove());
        }
      });
    }
  });

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      style={{ width: "100%", height: `${height()}px`, border: "none", display: "block" }}
      title="Email content"
    />
  );
}
