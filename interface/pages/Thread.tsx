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
  const [replyTo, setReplyTo] = createSignal("");
  const [replyCc, setReplyCc] = createSignal("");
  const [replyBcc, setReplyBcc] = createSignal("");
  const [showCcBcc, setShowCcBcc] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  let threadContentRef: HTMLDivElement | undefined;

  const fetchThread = (id: string) => {
    setLoading(true);
    setError(null);

    invoke<ThreadDetailResponse>("get_thread_detail", { threadId: id })
      .then((detail) => {
        setMessages(detail.messages);
        // Collapse all messages except the last one
        if (detail.messages.length > 1) {
          const ids = new Set(detail.messages.slice(0, -1).map((m) => m.id));
          setCollapsed(ids);
        } else {
          setCollapsed(new Set<string>());
        }
        // Scroll thread to bottom after load
        setTimeout(() => {
          if (threadContentRef) {
            threadContentRef.scrollTop = threadContentRef.scrollHeight;
          }
        }, 100);
      })
      .catch((e) => {
        console.error("Failed to load thread:", e);
        setError(typeof e === "string" ? e : "Failed to load thread");
      })
      .finally(() => setLoading(false));
  };

  // Fetch thread detail when threadId changes
  createEffect(() => {
    const id = props.threadId;
    setMessages([]);
    setCollapsed(new Set<string>());
    fetchThread(id);
  });

  // Pre-fill reply To when reply opens
  createEffect(() => {
    if (props.replyOpen) {
      const msg = lastMsg();
      if (msg) {
        setReplyTo(msg.fromEmail);
        setReplyCc(msg.cc || "");
        setReplyBcc("");
        setShowCcBcc(!!(msg.cc));
      }
    }
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

  const handleSend = async () => {
    const msg = lastMsg();
    if (!msg || !replyBody().trim() || !replyTo().trim()) return;

    setSending(true);
    setSendError(null);

    const subject = props.subject.startsWith("Re: ")
      ? props.subject
      : `Re: ${props.subject}`;

    const sentBody = replyBody();
    const sentTo = replyTo();
    const sentCc = replyCc();

    try {
      await invoke("send_reply", {
        threadId: props.threadId,
        messageId: msg.id,
        to: sentTo,
        cc: sentCc.trim() || null,
        bcc: replyBcc().trim() || null,
        subject,
        body: sentBody,
      });

      // Optimistically add sent message to thread immediately
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        + ", " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const htmlBody = sentBody
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      const sentMessage: Message = {
        id: `sent-${Date.now()}`,
        fromName: "Me",
        fromEmail: "me",
        to: sentTo,
        cc: sentCc,
        date: dateStr,
        bodyHtml: `<div style="white-space:pre-wrap;word-break:break-word">${htmlBody}</div>`,
      };

      // Collapse all existing messages, add sent message expanded
      setCollapsed(new Set(messages().map((m) => m.id)));
      setMessages((prev) => [...prev, sentMessage]);

      setReplyBody("");
      setReplyCc("");
      setReplyBcc("");
      setShowCcBcc(false);
      props.onReplyClose?.();

      // Scroll to bottom to show the new message
      setTimeout(() => {
        if (threadContentRef) {
          threadContentRef.scrollTop = threadContentRef.scrollHeight;
        }
      }, 50);

      // Background refresh to get real Gmail data
      setTimeout(() => fetchThread(props.threadId), 3000);
    } catch (e) {
      console.error("Send failed:", e);
      setSendError(typeof e === "string" ? e : "Failed to send reply");
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="h-full flex flex-col bg-white">
      {/* Actions row */}
      <div class="flex-shrink-0 px-20 pt-0 pb-2">
        <div class="flex items-center mb-3">
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

        {/* Guide hint */}
        <div class="mt-2 mb-2 flex items-center gap-3 opacity-60">
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
      </div>

      {/* Thread content — scrollable, shrinks when reply is open */}
      <div
        ref={threadContentRef}
        class={`overflow-y-auto px-20 ${
          props.replyOpen ? "flex-shrink-1 min-h-0" : "flex-1"
        }`}
        style={props.replyOpen ? { "max-height": "40%", "flex": "0 1 40%" } : {}}
      >
        <Show when={!loading()} fallback={
          <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading messages...</div>
        }>
          <Show when={!error()} fallback={
            <div class="flex items-center justify-center h-32 text-[13px] text-red-500">{error()}</div>
          }>
            <div class="space-y-5 pb-4">
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
      </div>

      {/* Reply area — takes priority when open */}
      <Show when={props.replyOpen && lastMsg()}>
        <div class="flex-1 min-h-0 flex flex-col">
          <div class="flex-1 min-h-0 flex flex-col px-20 py-4">
            {/* Reply header with To field and expand chevron for CC/BCC */}
            <div class="flex-shrink-0 space-y-2 mb-3">
              {/* To row */}
              <div class="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400 flex-shrink-0">
                  <path d="M6 12L2 8l4-4" />
                  <path d="M2 8h9a3 3 0 013 3v1" />
                </svg>
                <span class="text-[12px] text-zinc-400 flex-shrink-0">To</span>
                <input
                  type="text"
                  value={replyTo()}
                  onInput={(e) => setReplyTo(e.currentTarget.value)}
                  class="flex-1 text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-300"
                  placeholder="recipient@email.com"
                />
                <button
                  onClick={() => setShowCcBcc((v) => !v)}
                  class="text-zinc-400 hover:text-zinc-600 transition-colors p-0.5 flex-shrink-0"
                  title={showCcBcc() ? "Hide Cc/Bcc" : "Show Cc/Bcc"}
                >
                  <svg
                    width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                    class={`transition-transform ${showCcBcc() ? "rotate-180" : ""}`}
                  >
                    <path d="M3 4.5L6 7.5L9 4.5" />
                  </svg>
                </button>
              </div>

              {/* CC/BCC rows — expandable */}
              <Show when={showCcBcc()}>
                <div class="flex items-center gap-2">
                  <div class="w-[14px] flex-shrink-0" />
                  <span class="text-[12px] text-zinc-400 flex-shrink-0">Cc</span>
                  <input
                    type="text"
                    value={replyCc()}
                    onInput={(e) => setReplyCc(e.currentTarget.value)}
                    class="flex-1 text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-300"
                    placeholder="cc@email.com"
                  />
                </div>
                <div class="flex items-center gap-2">
                  <div class="w-[14px] flex-shrink-0" />
                  <span class="text-[12px] text-zinc-400 flex-shrink-0">Bcc</span>
                  <input
                    type="text"
                    value={replyBcc()}
                    onInput={(e) => setReplyBcc(e.currentTarget.value)}
                    class="flex-1 text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-300"
                    placeholder="bcc@email.com"
                  />
                </div>
              </Show>
            </div>

            {/* Textarea — grows to fill space */}
            <div class="flex-1 min-h-0 relative">
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
                    handleSend();
                  }
                }}
                placeholder="Write your reply..."
                disabled={sending()}
                class="absolute inset-0 w-full h-full text-[14px] text-zinc-800 leading-[1.7] bg-transparent resize-none outline-none placeholder:text-zinc-300 disabled:opacity-50"
              />
            </div>

            {/* Footer */}
            <div class="flex items-center gap-3 mt-3 flex-shrink-0">
              <Show when={sendError()}>
                <span class="text-[12px] text-red-500">{sendError()}</span>
              </Show>
              <span class="text-[11px] text-zinc-400">
                ⌘ Enter to send · Esc to discard
              </span>
              <div class="flex-1" />
              <div class="flex items-center gap-3">
                <button
                  disabled={sending() || !replyBody().trim() || !replyTo().trim()}
                  class="text-[12px] text-zinc-500 hover:text-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium flex items-center gap-1.5"
                  title="Schedule send"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M8 4.5V8l2.5 1.5" />
                  </svg>
                  Schedule
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending() || !replyBody().trim()}
                  class="px-3 py-1 rounded-md border border-zinc-200 text-[12px] text-zinc-500 hover:text-zinc-800 hover:border-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  {sending() ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Bottom padding when reply is NOT open */}
      <Show when={!props.replyOpen}>
        <div class="h-8 flex-shrink-0" />
      </Show>
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
        {/* Sender row */}
        <div class="flex items-baseline gap-2 cursor-pointer" onClick={props.onToggle}>
          <span class="text-[14px] font-semibold text-zinc-900">{msg().fromName}</span>
          <span class="text-[13px] text-zinc-400">{msg().fromEmail}</span>
          <div class="flex-1" />
          <span class="text-[12px] text-zinc-400 flex-shrink-0">{msg().date}</span>
        </div>

        {/* To line */}
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

        {/* Expanded details */}
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

        {/* Body */}
        <div class="mt-4 border-l-2 border-zinc-200 pl-5">
          <EmailBody html={msg().bodyHtml} />
        </div>
      </div>
    </Show>
  );
}

function EmailBody(props: { html: string }) {
  let iframeRef: HTMLIFrameElement | undefined;
  const [height, setHeight] = createSignal(60);

  const resizeToContent = () => {
    const doc = iframeRef?.contentDocument;
    if (doc?.body) {
      const h = doc.body.scrollHeight;
      if (h > 0) setHeight(h + 4);
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
