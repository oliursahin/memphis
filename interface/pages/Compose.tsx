import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface ComposeViewProps {
  onClose: () => void;
}

export default function ComposeView(props: ComposeViewProps) {
  const [to, setTo] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");
  const [showCc, setShowCc] = createSignal(false);
  const [cc, setCc] = createSignal("");
  const [bcc, setBcc] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);

  const handleSend = async () => {
    if (sending() || !to().trim() || !body().trim()) return;

    setSending(true);
    setSendError(null);

    try {
      await invoke("send_email", {
        to: to().trim(),
        cc: cc().trim() || null,
        bcc: bcc().trim() || null,
        subject: subject(),
        body: body(),
      });
      props.onClose();
    } catch (e) {
      console.error("Send failed:", e);
      setSendError(typeof e === "string" ? e : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div class="h-full flex flex-col bg-white" onKeyDown={handleKeyDown}>
      {/* Toolbar */}
      <div class="flex items-center gap-2 px-20 pt-5 pb-2 flex-shrink-0">
        <button
          onClick={props.onClose}
          class="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
      </div>

      {/* Compose area */}
      <div class="flex-1 flex flex-col overflow-y-auto px-20">
        <span class="text-[13px] text-zinc-600 mb-2">New Message</span>
        {/* To */}
        <div class="flex items-center gap-2 py-2 flex-shrink-0">
          <span class="text-[13px] text-zinc-600 flex-shrink-0">To</span>
          <input
            type="text"
            value={to()}
            onInput={(e) => setTo(e.currentTarget.value)}
            class="bg-transparent text-[13px] text-black outline-none placeholder:text-zinc-400"
            placeholder="recipient@example.com"
            autofocus
          />
          <button
            onClick={() => setShowCc(!showCc())}
            class="text-zinc-400 hover:text-zinc-600 transition-colors p-0.5 flex-shrink-0"
            title={showCc() ? "Hide Cc/Bcc" : "Show Cc/Bcc"}
          >
            <svg
              width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
              class={`transition-transform ${showCc() ? "rotate-180" : ""}`}
            >
              <path d="M3 4.5L6 7.5L9 4.5" />
            </svg>
          </button>
        </div>

        <Show when={showCc()}>
          <div class="flex items-center gap-2 py-2 flex-shrink-0">
            <span class="text-[13px] text-zinc-600 flex-shrink-0">Cc</span>
            <input
              type="text"
              value={cc()}
              onInput={(e) => setCc(e.currentTarget.value)}
              class="flex-1 bg-transparent text-[13px] text-black outline-none placeholder:text-zinc-400"
              placeholder="cc@example.com"
            />
          </div>
          <div class="flex items-center gap-2 py-2 flex-shrink-0">
            <span class="text-[13px] text-zinc-600 flex-shrink-0">Bcc</span>
            <input
              type="text"
              value={bcc()}
              onInput={(e) => setBcc(e.currentTarget.value)}
              class="flex-1 bg-transparent text-[13px] text-black outline-none placeholder:text-zinc-400"
              placeholder="bcc@example.com"
            />
          </div>
        </Show>

        {/* Subject */}
        <div class="py-2 flex-shrink-0">
          <input
            type="text"
            value={subject()}
            onInput={(e) => setSubject(e.currentTarget.value)}
            class="w-full bg-transparent text-[14px] font-medium text-black outline-none placeholder:text-zinc-400"
            placeholder="Subject"
          />
        </div>

        {/* Body */}
        <textarea
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          class="flex-1 min-h-[200px] mt-2 bg-transparent text-[14px] text-black leading-[1.7] outline-none resize-none placeholder:text-zinc-400 disabled:opacity-50"
          placeholder="Write your message..."
          disabled={sending()}
        />

      </div>

      {/* Footer — fixed at bottom */}
      <div class="flex-shrink-0 px-20 py-3 flex items-center gap-3">
        <Show when={sendError()}>
          <span class="text-[12px] text-red-500">{sendError()}</span>
        </Show>
        <div class="flex-1" />
        <span class="text-[11px] text-zinc-400">
          ⌘ Enter to send · Esc to discard
        </span>
        <button
          onClick={handleSend}
          disabled={sending() || !to().trim() || !body().trim()}
          class="px-3 py-1 rounded-md border border-zinc-200 text-[12px] text-zinc-500 hover:text-black hover:border-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
        >
          {sending() ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
