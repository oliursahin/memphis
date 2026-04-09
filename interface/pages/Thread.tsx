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
  replyAll?: boolean;
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
  const [showSignature, setShowSignature] = createSignal(false);
  const [signature, setSignature] = createSignal("Sent with Morphis · morphism.me");
  const [signatureEnabled, setSignatureEnabled] = createSignal(true);
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
        // Scroll to top on initial load
        setTimeout(() => {
          if (threadContentRef) {
            threadContentRef.scrollTop = 0;
          }
        }, 50);
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

  // Pre-fill reply To when reply opens & scroll thread to bottom
  createEffect(() => {
    if (props.replyOpen) {
      const msg = lastMsg();
      if (msg) {
        setReplyTo(msg.fromEmail);
        if (props.replyAll) {
          setReplyCc(msg.cc || "");
          setShowCcBcc(!!(msg.cc));
        } else {
          setReplyCc("");
          setShowCcBcc(false);
        }
        setReplyBcc("");
      }
      // Scroll thread content to bottom so the last message is visible
      const scrollToBottom = () => {
        if (threadContentRef) {
          threadContentRef.scrollTop = threadContentRef.scrollHeight;
        }
      };
      setTimeout(scrollToBottom, 50);
      setTimeout(scrollToBottom, 300);
      setTimeout(scrollToBottom, 800);
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

    const sentBody = signatureEnabled() && signature().trim()
      ? `${replyBody()}\n\n---\n${signature()}`
      : replyBody();
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
      {/* Thread content — subject + messages scrollable together */}
      <div ref={threadContentRef} class={`overflow-y-auto px-20 flex-1 min-h-0`}>
        {/* Subject */}
        <h1 class="text-[20px] font-semibold text-zinc-900 leading-tight pt-4 pb-2">
          {props.subject}
        </h1>
        <Show when={!loading()} fallback={
          <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading messages...</div>
        }>
          <Show when={!error()} fallback={
            <div class="flex items-center justify-center h-32 text-[13px] text-red-500">{error()}</div>
          }>
            <div class="space-y-5 pb-12">
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

      {/* Reply area — bordered box at bottom */}
      <Show when={props.replyOpen && lastMsg()}>
        <div class="flex-1 min-h-0 flex flex-col border-t border-b border-zinc-200 relative">
          {/* Close button — top right */}
          <button
            onClick={() => {
              setReplyBody("");
              setReplyCc("");
              setReplyBcc("");
              setShowCcBcc(false);
              props.onReplyClose?.();
            }}
            class="absolute top-3 right-4 text-zinc-400 hover:text-zinc-600 transition-colors p-0.5"
            title="Discard reply"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
          <div class="flex-1 min-h-0 flex flex-col px-20 py-4">
            {/* Reply header with To field */}
            <div class="flex-shrink-0 space-y-2 mb-3">
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
                  size={Math.max(replyTo().length || 18, 18)}
                  class="text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-400"
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

              <Show when={showCcBcc()}>
                <div class="flex items-center gap-2">
                  <div class="w-[14px] flex-shrink-0" />
                  <span class="text-[12px] text-zinc-400 flex-shrink-0">Cc</span>
                  <input
                    type="text"
                    value={replyCc()}
                    onInput={(e) => setReplyCc(e.currentTarget.value)}
                    class="flex-1 text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-400"
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
                    class="flex-1 text-[13px] text-zinc-700 bg-transparent outline-none placeholder:text-zinc-400"
                    placeholder="bcc@email.com"
                  />
                </div>
              </Show>
            </div>

            {/* Textarea */}
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
                class="absolute inset-0 w-full h-full text-[14px] text-zinc-800 leading-[1.7] bg-transparent resize-none outline-none placeholder:text-zinc-400 disabled:opacity-50"
              />
            </div>

            {/* Signature preview */}
            <div class="flex-shrink-0 pt-2">
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignature((v) => !v)}
                  class="text-[13px] text-zinc-400 leading-relaxed hover:text-zinc-500 transition-colors cursor-pointer"
                >
                  ---
                </button>
                <Show when={showSignature()}>
                  <button
                    type="button"
                    onClick={() => setSignatureEnabled((v) => !v)}
                    class={`text-[11px] transition-colors ${signatureEnabled() ? "text-zinc-400 hover:text-red-400" : "text-red-400 hover:text-zinc-400"}`}
                    title={signatureEnabled() ? "Remove signature" : "Add signature"}
                  >
                    {signatureEnabled() ? "remove" : "add back"}
                  </button>
                </Show>
              </div>
              <Show when={showSignature() && signatureEnabled()}>
                <input
                  type="text"
                  value={signature()}
                  onInput={(e) => setSignature(e.currentTarget.value)}
                  class="w-full text-[13px] text-zinc-400 leading-relaxed bg-transparent outline-none placeholder:text-zinc-300"
                  placeholder="Your signature..."
                />
              </Show>
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
          <span class="text-[12px] text-zinc-500 truncate flex-1">{plainPreview()}</span>
          <span class="text-[12px] text-zinc-500 flex-shrink-0">{msg().date}</span>
        </div>
      </div>
    }>
      <div>
        {/* Sender row */}
        <div class="flex items-baseline gap-2 cursor-pointer" onClick={props.onToggle}>
          <span class="text-[14px] font-semibold text-zinc-900">{msg().fromName}</span>
          <span class="text-[13px] text-zinc-500">{msg().fromEmail}</span>
          <div class="flex-1" />
          <span class="text-[12px] text-zinc-500 flex-shrink-0">{msg().date}</span>
        </div>

        {/* To line */}
        <div class="mt-0.5 flex items-center gap-1">
          <span class="text-[12px] text-zinc-500">To {toShort()}</span>
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
          <div class="mt-1.5 pl-0 space-y-0.5 text-[12px] text-zinc-500">
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src https: data:;">
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
      doc.body.addEventListener("click", (e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (anchor) {
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (href && (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:"))) {
            import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
          }
        }
      });

      doc.body.querySelectorAll("img").forEach((img) => {
        img.addEventListener("load", resizeToContent);
        img.addEventListener("error", () => img.remove());
      });
    }
  });

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin allow-scripts"
      style={{ width: "100%", height: `${height()}px`, border: "none", display: "block" }}
      title="Email content"
    />
  );
}
