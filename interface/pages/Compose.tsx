import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface ComposeViewProps {
  onClose: () => void;
  initialSubject?: string;
  initialTo?: string;
  initialBody?: string;
  initialBodyHtml?: string;
  initialCc?: string;
  initialBcc?: string;
  onDraftSaved?: (draft: { id: string; subject: string; to: string; snippet: string; body: string; bodyHtml: string; cc?: string; bcc?: string }) => void;
  onSent?: () => void;
}

// Floating toolbar button
function ToolbarBtn(props: { label: string; command: string; arg?: string; icon?: any }) {
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault(); // keep selection alive
        if (props.arg !== undefined) {
          document.execCommand(props.command, false, props.arg);
        } else {
          document.execCommand(props.command, false);
        }
      }}
      class="w-8 h-8 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 transition-colors text-[13px] font-semibold"
      title={props.label}
    >
      {props.icon ?? props.label}
    </button>
  );
}

export default function ComposeView(props: ComposeViewProps) {
  const [to, setTo] = createSignal(props.initialTo ?? "");
  const [subject, setSubject] = createSignal(props.initialSubject ?? "");
  const [showCc, setShowCc] = createSignal(!!(props.initialCc || props.initialBcc));
  const [cc, setCc] = createSignal(props.initialCc ?? "");
  const [bcc, setBcc] = createSignal(props.initialBcc ?? "");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [showSignature, setShowSignature] = createSignal(false);
  const [signature, setSignature] = createSignal("Sent with Memphis · morphism.me");
  const [signatureEnabled, setSignatureEnabled] = createSignal(true);
  const [toolbarPos, setToolbarPos] = createSignal<{ x: number; y: number } | null>(null);
  const [showLinkInput, setShowLinkInput] = createSignal(false);
  const [linkUrl, setLinkUrl] = createSignal("");
  const [draftId, setDraftId] = createSignal<string | null>(null);
  const [draftStatus, setDraftStatus] = createSignal<"" | "saving" | "saved">("");
  const [bodyEmpty, setBodyEmpty] = createSignal(!(props.initialBody || props.initialBodyHtml));
  let savedRange: Range | null = null;
  let saveTimer: number | undefined;

  let editorRef: HTMLDivElement | undefined;

  const getBodyHtml = () => {
    if (!editorRef) return "";
    const html = editorRef.innerHTML;
    if (!html || html === "<br>" || html === "<div><br></div>") return "";
    return html;
  };

  const getBodyText = () => {
    const html = getBodyHtml();
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.innerText || "";
  };

  // Local draft ID for display before Gmail sync
  let localDraftId = `local-draft-${Date.now()}`;

  // Update local draft in the split immediately
  const updateLocalDraft = () => {
    const bodyText = getBodyText();
    const bodyHtml = getBodyHtml();
    props.onDraftSaved?.({
      id: draftId() || localDraftId,
      subject: subject() || "(no subject)",
      to: to().trim() || "Me",
      snippet: bodyText.slice(0, 100),
      body: bodyText,
      bodyHtml,
      cc: cc().trim() || undefined,
      bcc: bcc().trim() || undefined,
    });
  };


  // Sync draft to Gmail (debounced, background)
  const saveDraftToGmail = async () => {
    const bodyText = getBodyText();
    if (!to().trim() && !subject().trim() && !bodyText.trim()) return;

    setDraftStatus("saving");
    try {
      const id = await invoke<string>("save_draft", {
        draftId: draftId(),
        to: to().trim(),
        cc: cc().trim() || null,
        bcc: bcc().trim() || null,
        subject: subject(),
        body: bodyText,
        bodyHtml: getBodyHtml() || null,
      });
      setDraftId(id);
      setDraftStatus("saved");
    } catch (e) {
      console.error("Draft save failed:", e);
      setDraftStatus("");
    }
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    setDraftStatus("");
    setBodyEmpty(!getBodyText().trim());
    // Show locally immediately
    updateLocalDraft();
    // Sync to Gmail after 2s
    saveTimer = window.setTimeout(saveDraftToGmail, 2000);
  };

  const handleSend = async () => {
    const bodyText = getBodyText();
    if (sending() || !to().trim() || !bodyText.trim()) return;

    // Cancel any pending draft save
    if (saveTimer) clearTimeout(saveTimer);

    setSending(true);
    setSendError(null);

    const hasSig = signatureEnabled() && signature().trim();
    const sentBody = hasSig
      ? `${bodyText}\n\n---\n${signature()}`
      : bodyText;

    const rawHtml = getBodyHtml();
    const sentHtml = rawHtml
      ? hasSig
        ? `${rawHtml}<br><br><hr style="border:none;border-top:1px solid #e4e4e7"><p style="color:#71717a">${signature().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
        : rawHtml
      : null;

    try {
      // Delete the draft if one was saved, since we're sending
      const did = draftId();
      if (did) {
        invoke("delete_draft", { draftId: did }).catch(console.error);
      }

      await invoke("send_email", {
        to: to().trim(),
        cc: cc().trim() || null,
        bcc: bcc().trim() || null,
        subject: subject(),
        body: sentBody,
        bodyHtml: sentHtml,
      });
      props.onSent?.();
      props.onClose();
    } catch (e) {
      console.error("Send failed:", e);
      setSendError(typeof e === "string" ? e : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  // Show/hide toolbar based on text selection within the editor
  const updateToolbar = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !editorRef) {
      setToolbarPos(null);
      return;
    }
    // Only show if selection is inside our editor
    if (!editorRef.contains(sel.anchorNode)) {
      setToolbarPos(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const rangeRect = range.getBoundingClientRect();
    const editorRect = editorRef.getBoundingClientRect();
    if (rangeRect.width === 0) {
      setToolbarPos(null);
      return;
    }
    // Position relative to the editor
    setToolbarPos({
      x: rangeRect.left - editorRect.left + rangeRect.width / 2,
      y: rangeRect.top - editorRect.top - 8,
    });
  };

  const handleLink = (e: MouseEvent) => {
    e.preventDefault();
    // Save the current selection before focus moves to the URL input
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
    setLinkUrl("");
    setShowLinkInput(true);
  };

  const applyLink = () => {
    const url = linkUrl().trim();
    if (url && savedRange) {
      // Restore the saved selection
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      document.execCommand("createLink", false, url);
    }
    setShowLinkInput(false);
    setLinkUrl("");
    savedRange = null;
  };

  onMount(() => {
    document.addEventListener("selectionchange", updateToolbar);
    // Restore body from previous draft if reopening (prefer HTML to preserve formatting)
    if (editorRef) {
      if (props.initialBodyHtml) {
        editorRef.innerHTML = props.initialBodyHtml;
      } else if (props.initialBody) {
        editorRef.innerText = props.initialBody;
      }
      editorRef.classList.toggle("is-empty", !getBodyHtml());
    }
    // Show draft in split immediately
    updateLocalDraft();
  });
  onCleanup(() => {
    document.removeEventListener("selectionchange", updateToolbar);
    // Flush any pending draft save instead of discarding it
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveDraftToGmail();
    }
  });

  return (
    <div class="h-full flex flex-col items-center bg-white overflow-y-auto pr-[10%]" onKeyDown={handleKeyDown}>
      {/* Title */}
      <div class="w-[70%] flex items-center pt-5 pb-3 flex-shrink-0">
        <button
          onClick={props.onClose}
          class="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors mr-3"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
        <span class="text-[15px] font-medium text-zinc-900">Draft</span>
      </div>

      {/* Compose box — centered card, grows with content */}
      <div class="w-[70%] flex flex-col border border-zinc-200 rounded-lg">
        <div class="flex flex-col px-8 pt-10 pb-6">
          {/* Header fields */}
          <div class="flex-shrink-0 space-y-3 mb-4">
            {/* To row */}
            <div class="flex items-center gap-3">
              <input
                type="text"
                value={to()}
                onInput={(e) => { setTo(e.currentTarget.value); scheduleSave(); }}
                class="flex-1 text-[14px] text-zinc-800 bg-transparent outline-none placeholder:text-zinc-400"
                placeholder="To"
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

            {/* CC/BCC rows — expandable */}
            <Show when={showCc()}>
              <div class="flex items-center gap-3">
                <input
                  type="text"
                  value={cc()}
                  onInput={(e) => { setCc(e.currentTarget.value); scheduleSave(); }}
                  class="flex-1 text-[14px] text-zinc-800 bg-transparent outline-none placeholder:text-zinc-400"
                  placeholder="Cc"
                />
              </div>
              <div class="flex items-center gap-3">
                <input
                  type="text"
                  value={bcc()}
                  onInput={(e) => { setBcc(e.currentTarget.value); scheduleSave(); }}
                  class="flex-1 text-[14px] text-zinc-800 bg-transparent outline-none placeholder:text-zinc-400"
                  placeholder="Bcc"
                />
              </div>
            </Show>

            {/* Subject row */}
            <div class="flex items-center gap-3">
              <input
                type="text"
                value={subject()}
                onInput={(e) => { setSubject(e.currentTarget.value); scheduleSave(); }}
                class="flex-1 text-[15px] text-zinc-900 font-medium bg-transparent outline-none placeholder:text-zinc-400"
                placeholder="Subject"
              />
            </div>
          </div>

          {/* Rich text editor */}
          <div class="relative mt-2">
            <div
              ref={editorRef}
              contentEditable
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              data-placeholder="Write your message..."
              onInput={() => {
                editorRef?.classList.toggle("is-empty", !getBodyHtml());
                scheduleSave();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onClose();
                }
              }}
              class={`compose-editor w-full min-h-[240px] text-[14px] text-zinc-800 leading-[1.7] outline-none${bodyEmpty() ? " is-empty" : ""}`}
              style={{
                "word-break": "break-word",
                "overflow-wrap": "break-word",
              }}
            />

            {/* Floating formatting toolbar — inside editor container */}
            <Show when={toolbarPos()}>
              {(pos) => (
                <div
                  class="absolute z-50 flex flex-col bg-white border border-zinc-200 rounded-lg"
                  style={{
                    left: `${pos().x}px`,
                    top: `${pos().y}px`,
                    transform: "translate(-50%, -100%)",
                  }}
                >
                  <div class="flex items-center gap-0.5 px-1 py-1">
                  <ToolbarBtn label="Bold" command="bold" icon={<span class="font-bold">B</span>} />
                  <ToolbarBtn label="Italic" command="italic" icon={<span class="italic">I</span>} />
                  <ToolbarBtn label="Underline" command="underline" icon={<span class="underline">U</span>} />
                  <div class="w-px h-5 bg-zinc-200 mx-0.5" />
                  <button
                    onMouseDown={handleLink}
                    class={`w-8 h-8 flex items-center justify-center rounded transition-colors ${showLinkInput() ? "text-zinc-900 bg-zinc-100" : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100"}`}
                    title="Link"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6.5 9.5a3 3 0 004 .5l2-2a3 3 0 00-4.24-4.24l-1.14 1.14" />
                      <path d="M9.5 6.5a3 3 0 00-4-.5l-2 2a3 3 0 004.24 4.24l1.14-1.14" />
                    </svg>
                  </button>
                  <div class="w-px h-5 bg-zinc-200 mx-0.5" />
                  <ToolbarBtn
                    label="Ordered List"
                    command="insertOrderedList"
                    icon={
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 3h8M6 8h8M6 13h8" />
                        <text x="1" y="5" fill="currentColor" stroke="none" font-size="5" font-weight="600">1</text>
                        <text x="1" y="10" fill="currentColor" stroke="none" font-size="5" font-weight="600">2</text>
                        <text x="1" y="15" fill="currentColor" stroke="none" font-size="5" font-weight="600">3</text>
                      </svg>
                    }
                  />
                  <ToolbarBtn
                    label="Bullet List"
                    command="insertUnorderedList"
                    icon={
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 3h8M6 8h8M6 13h8" />
                        <circle cx="2.5" cy="3" r="1" fill="currentColor" stroke="none" />
                        <circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none" />
                        <circle cx="2.5" cy="13" r="1" fill="currentColor" stroke="none" />
                      </svg>
                    }
                  />
                  <div class="w-px h-5 bg-zinc-200 mx-0.5" />
                  <ToolbarBtn
                    label="Quote"
                    command="formatBlock"
                    arg="blockquote"
                    icon={
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="none">
                        <path d="M3.5 9.5c-.8 0-1.5-.7-1.5-1.5V6c0-1.7 1.3-3 3-3h.5v1.5H5c-.8 0-1.5.7-1.5 1.5v.5h1.5c.6 0 1 .4 1 1V9c0 .3-.2.5-.5.5H3.5zM9.5 9.5c-.8 0-1.5-.7-1.5-1.5V6c0-1.7 1.3-3 3-3h.5v1.5H11c-.8 0-1.5.7-1.5 1.5v.5h1.5c.6 0 1 .4 1 1V9c0 .3-.2.5-.5.5H9.5z" />
                      </svg>
                    }
                  />
                  </div>
                  {/* Inline link URL input */}
                  <Show when={showLinkInput()}>
                    <div class="flex items-center gap-2 px-2 py-1.5 border-t border-zinc-200">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400 flex-shrink-0">
                        <path d="M6.5 9.5a3 3 0 004 .5l2-2a3 3 0 00-4.24-4.24l-1.14 1.14" />
                        <path d="M9.5 6.5a3 3 0 00-4-.5l-2 2a3 3 0 004.24 4.24l1.14-1.14" />
                      </svg>
                      <input
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                        type="text"
                        value={linkUrl()}
                        onInput={(e) => setLinkUrl(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyLink();
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setShowLinkInput(false);
                            savedRange = null;
                          }
                        }}
                        placeholder="https://..."
                        class="w-[200px] text-[13px] text-zinc-800 bg-transparent outline-none placeholder:text-zinc-400"
                      />
                      <button
                        onMouseDown={(e) => { e.preventDefault(); applyLink(); }}
                        class="text-[11px] text-zinc-500 hover:text-zinc-900 font-medium px-1"
                      >
                        Apply
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
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
              {draftStatus() === "saving" ? "Saving draft..." : draftStatus() === "saved" ? "Draft saved" : "⌘ Enter to send · Esc to discard"}
            </span>
            <div class="flex-1" />
            <button
              onClick={handleSend}
              disabled={sending() || !to().trim() || bodyEmpty()}
              class="px-3 py-1 rounded-md border border-zinc-200 text-[12px] text-zinc-500 hover:text-zinc-800 hover:border-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              {sending() ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Bottom padding */}
      <div class="h-10 flex-shrink-0" />

    </div>
  );
}
