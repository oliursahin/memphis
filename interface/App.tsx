import { createSignal, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ThreadView from "./pages/Thread";
import ComposeView from "./pages/Compose";
import SearchPalette from "./components/SearchPalette";
import CommandPalette from "./components/CommandPalette";
import LabelPicker from "./components/LabelPicker";
import Inbox from "./pages/Inbox";
import type { ThreadRow } from "./pages/Inbox";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import SplitSetup from "./pages/SplitSetup";
import type { SplitConfig } from "./pages/SplitSetup";

interface InboxZeroPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
}

interface AppAccount {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
  isActive: boolean;
}

interface OpenThread {
  id: string;
  subject: string;
}

interface InboxResponse {
  threads: ThreadRow[];
  nextPageToken: string | null;
}

const MAILBOX_DEFS = [
  { id: "done", label: "Done", query: "-in:inbox -in:trash -in:spam", emptyText: "No archived emails" },
  { id: "sent", label: "Sent", query: "in:sent", emptyText: "No sent emails" },
  { id: "drafts", label: "Drafts", query: "in:drafts", emptyText: "No drafts" },
  { id: "bin", label: "Bin", query: "in:trash", emptyText: "Bin is empty" },
  { id: "spam", label: "Spam", query: "in:spam", emptyText: "No spam" },
  { id: "starred", label: "Starred", query: "is:starred", emptyText: "No starred emails" },
  { id: "all", label: "All Mail", query: "-in:spam -in:trash", emptyText: "No emails" },
] as const;

function getInitials(account: AppAccount): string {
  const name = account.displayName || account.email.split("@")[0];
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

export default function App() {
  const [authed, setAuthed] = createSignal<boolean | null>(null); // null = loading
  const [accounts, setAccounts] = createSignal<AppAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = createSignal<string | null>(null);
  const [needsSetup, setNeedsSetup] = createSignal(false);
  const [splits, setSplits] = createSignal<SplitConfig[]>([]);

  // Per-split thread cache — switching tabs is instant
  const [splitThreads, setSplitThreads] = createSignal<Record<string, ThreadRow[]>>({});
  const [loadingSplits, setLoadingSplits] = createSignal<Set<string>>(new Set());

  // Derived from cache
  const threads = () => splitThreads()[activeTab()] ?? [];
  const loadingInbox = () => loadingSplits().has(activeTab());

  const activeAccount = createMemo(() => accounts().find((a) => a.id === activeAccountId()));

  // Track avatar load failures so we fall back to initials
  const [avatarFailed, setAvatarFailed] = createSignal(false);

  // True when showing a split with no threads and nothing else open
  const isInboxZero = () =>
    threads().length === 0 && !loadingInbox() && !openThread() && !showCompose() && !showSettings() && !activeMailbox();

  // Derive thread counts reactively from cached data — inbox zero cares about total, not unread
  const threadCounts = () => {
    const all = splitThreads();
    const out: Record<string, number> = {};
    for (const [id, list] of Object.entries(all)) {
      out[id] = list.length;
    }
    return out;
  };
  const [activeTab, setActiveTab] = createSignal("important");
  const [openThread, setOpenThread] = createSignal<OpenThread | null>(null);
  const [showCompose, setShowCompose] = createSignal(false);
  const [composeInitial, setComposeInitial] = createSignal<{ subject?: string } | null>(null);
  const [labelPickerMode, setLabelPickerMode] = createSignal<"apply-label" | "remove-label" | "move-to" | null>(null);
  const [showSearch, setShowSearch] = createSignal(false);
  const [showCommandBar, setShowCommandBar] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [inlineReply, setInlineReply] = createSignal(false);
  const [replyAll, setReplyAll] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showAccountPicker, setShowAccountPicker] = createSignal(false);

  // Inbox-zero background from Unsplash (cached once per day in localStorage)
  const [inboxZeroPhoto, setInboxZeroPhoto] = createSignal<InboxZeroPhoto | null>(null);
  const fetchInboxZeroPhoto = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cached = localStorage.getItem("inbox_zero_photo");
    if (cached) {
      try {
        const { date, photo } = JSON.parse(cached);
        if (date === today) {
          setInboxZeroPhoto(photo);
          return;
        }
      } catch { /* stale cache, refetch */ }
    }
    try {
      const photo = await invoke<InboxZeroPhoto>("get_inbox_zero_photo");
      setInboxZeroPhoto(photo);
      localStorage.setItem("inbox_zero_photo", JSON.stringify({ date: today, photo }));
    } catch (e) {
      console.warn("Failed to fetch inbox-zero photo:", e);
    }
  };

  // Unified mailbox state
  const [mailboxes, setMailboxes] = createSignal<Record<string, { threads: ThreadRow[]; loading: boolean }>>(
    Object.fromEntries(MAILBOX_DEFS.map((m) => [m.id, { threads: [], loading: false }]))
  );
  const [activeMailbox, setActiveMailbox] = createSignal<string | null>(null);

  // Bump this whenever default split queries change to force re-setup
  const SPLITS_VERSION = 9;

  const refreshAccounts = async () => {
    try {
      // Backfill missing avatars from Google profile, then fetch
      await invoke("refresh_account_profiles").catch(() => {});
      const fetched = await invoke<AppAccount[]>("get_accounts");
      setAccounts(fetched);
      if (fetched.length > 0) {
        // Restore saved active account, or default to first
        const savedId = await invoke<string | null>("get_setting", { key: "active_account_id" }).catch(() => null);
        const validId = fetched.find((a) => a.id === savedId)?.id ?? fetched[0].id;
        setActiveAccountId(validId);
      }
    } catch { /* non-critical */ }
  };

  const switchAccount = async (accountId: string) => {
    setActiveAccountId(accountId);
    setAvatarFailed(false);
    await invoke("save_setting", { key: "active_account_id", value: accountId });
    setOpenThread(null);
    setActiveMailbox(null);
    const needsSetupNow = await loadSplitsForAccount(accountId);
    if (needsSetupNow) setNeedsSetup(true);
    // Trigger sync for the new account so its cache gets populated
    invoke("trigger_sync").catch(console.error);
  };

  // Load splits for a given account, returning true if setup is needed
  const loadSplitsForAccount = async (accountId: string): Promise<boolean> => {
    const saved = await invoke<SplitConfig[]>("get_splits", { accountId });
    const versionKey = `splits_version:${accountId}`;
    const savedVersion = await invoke<number | null>("get_setting", { key: versionKey }).catch(() => null);
    const isStale = saved.length === 0 || savedVersion !== SPLITS_VERSION;
    if (!isStale) {
      setSplits(saved);
      setActiveTab(saved[0].id);
      setSplitThreads({});
      loadAllSplits();
      prefetchAllMailboxes();
      fetchInboxZeroPhoto();
      return false;
    }
    setSplits([]);
    setSplitThreads({});
    return true;
  };

  const checkAuth = async () => {
    try {
      const has = await invoke<boolean>("has_accounts");
      setAuthed(has);
      if (has) {
        await refreshAccounts();
        const accountId = activeAccountId();
        if (!accountId) return;
        const needsSetupNow = await loadSplitsForAccount(accountId);
        if (needsSetupNow) setNeedsSetup(true);
      }
    } catch {
      setAuthed(false);
    }
  };

  // ── Local split filtering (replaces per-split Gmail API calls) ──

  // Returns true/false for evaluatable terms, null for terms we can't check locally
  const evaluateTerm = (thread: ThreadRow, labels: Set<string>, term: string): boolean | null => {
    const negated = term.startsWith("-");
    const clean = negated ? term.slice(1) : term;
    let matches: boolean;
    if (clean === "in:inbox") matches = labels.has("INBOX");
    else if (clean === "is:important") matches = labels.has("IMPORTANT");
    else if (clean === "is:starred") matches = labels.has("STARRED");
    else if (clean.startsWith("category:")) {
      matches = labels.has(`CATEGORY_${clean.slice(9).toUpperCase()}`);
    } else if (clean.startsWith("from:")) {
      // Check all sender emails in the thread (matches Gmail search behavior)
      const target = clean.slice(5).toLowerCase();
      const senders = thread.senderEmails;
      matches = senders && senders.length > 0
        ? senders.some((e) => e.toLowerCase() === target)
        : thread.fromEmail.toLowerCase() === target;
    } else {
      return null; // Can't evaluate locally (filename:, has:, etc.)
    }
    return negated ? !matches : matches;
  };

  const matchesSplitQuery = (thread: ThreadRow, query: string): boolean => {
    if (!query) return true;
    const labels = new Set(thread.labelIds || []);
    // OR group: {term1 term2 ...} — match if any known term is true
    if (query.startsWith("{") && query.endsWith("}")) {
      const terms = query.slice(1, -1).trim().split(/\s+/);
      const results = terms.map((t) => evaluateTerm(thread, labels, t));
      const known = results.filter((r): r is boolean => r !== null);
      return known.length > 0 ? known.some(Boolean) : false;
    }
    // AND: all known terms must match (unknown terms are skipped)
    const terms = query.trim().split(/\s+/);
    const results = terms.map((t) => evaluateTerm(thread, labels, t));
    const known = results.filter((r): r is boolean => r !== null);
    return known.length > 0 ? known.every(Boolean) : true;
  };

  // Helper: is this thread a "known category" (calendar or GitHub)?
  // Used to exclude from broad splits like Important even when those splits aren't configured.
  const isKnownCategory = (thread: ThreadRow): boolean => {
    if (thread.isCalendar) return true;
    const senders = thread.senderEmails;
    if (senders && senders.some((e) => e === "notifications@github.com")) return true;
    if (thread.fromEmail === "notifications@github.com") return true;
    return false;
  };

  const threadMatchesSplit = (
    thread: ThreadRow, split: SplitConfig, allSplits: SplitConfig[]
  ): boolean => {
    const labels = new Set(thread.labelIds || []);

    // Catch-all: everything in INBOX not matched by other specific splits
    if (split.query === "*") {
      if (!labels.has("INBOX")) return false;
      return !allSplits.some(
        (s) => s.id !== split.id && s.query !== "*" && threadMatchesSplit(thread, s, [])
      );
    }
    // Calendar split: use the backend-detected flag (Gmail filename:ics search)
    if (split.id === "calendar") {
      if (!labels.has("INBOX")) return false;
      return thread.isCalendar === true;
    }
    // Label-based split (has gmailLabelId)
    if (split.gmailLabelId) return labels.has(split.gmailLabelId);
    // Label query without gmailLabelId
    if (split.query?.startsWith("label:")) return false;
    // Must be in INBOX for all other splits
    if (!labels.has("INBOX")) return false;
    // Specific splits (from:, OR groups) — just check the query
    if (split.query?.startsWith("from:") || split.query?.startsWith("{")) {
      return matchesSplitQuery(thread, split.query || "");
    }
    // Broad splits (is:important, etc.) — check query AND exclude known categories + specific splits
    if (!matchesSplitQuery(thread, split.query || "")) return false;
    // Exclude calendar/GitHub threads from broad splits even if those splits aren't configured
    if (isKnownCategory(thread)) return false;
    if (allSplits.length > 0) {
      const inSpecific = allSplits.some((s) => {
        if (s.id === split.id || !s.query || s.query === "*" || s.id === "calendar") return false;
        if (s.query.startsWith("from:") || s.query.startsWith("{") || s.gmailLabelId) {
          return threadMatchesSplit(thread, s, []);
        }
        return false;
      });
      if (inSpecific) return false;
    }
    return true;
  };

  const filterThreadsForSplit = (
    allThreads: ThreadRow[], split: SplitConfig, allSplits: SplitConfig[]
  ): ThreadRow[] => {
    return allThreads.filter((t) => threadMatchesSplit(t, split, allSplits));
  };

  // Load all threads from SQLite cache, filter into splits locally
  const loadAllSplits = async () => {
    const allSplits = splits();
    if (allSplits.length === 0) return;

    setLoadingSplits(new Set(allSplits.map((s) => s.id)));

    try {
      const allThreads = await invoke<ThreadRow[]>("list_inbox_cached");

      if (allThreads.length === 0) {
        // Cache empty — could be initial sync or genuinely empty inbox.
        // Clear loading so the UI shows empty splits instead of infinite spinner.
        setLoadingSplits(new Set<string>());
        return;
      }

      const newSplitThreads: Record<string, ThreadRow[]> = {};
      for (const split of allSplits) {
        newSplitThreads[split.id] = filterThreadsForSplit(allThreads, split, allSplits);
      }
      setSplitThreads(newSplitThreads);
      setLoadingSplits(new Set<string>());
    } catch (e) {
      console.error("Failed to load from cache:", e);
      setLoadingSplits(new Set<string>());
    }
  };

  // Switching tabs is instant — data already in cache
  const loadSplit = (splitId: string) => {
    setActiveTab(splitId);
    setActiveMailbox(null);
  };

  // Unified mailbox prefetch
  const prefetchMailbox = async (id: string) => {
    const def = MAILBOX_DEFS.find((m) => m.id === id);
    if (!def) return;
    setMailboxes((prev) => ({ ...prev, [id]: { ...prev[id], loading: true } }));
    try {
      const res = await invoke<InboxResponse>("list_inbox", {
        maxResults: 50,
        labelId: null,
        query: def.query,
      });
      setMailboxes((prev) => ({ ...prev, [id]: { threads: res.threads, loading: false } }));
    } catch (e) {
      console.error(`Failed to load ${id}:`, e);
      setMailboxes((prev) => ({ ...prev, [id]: { ...prev[id], loading: false } }));
    }
  };

  const prefetchAllMailboxes = () => {
    for (const def of MAILBOX_DEFS) prefetchMailbox(def.id);
  };

  const closeAllViews = () => {
    setActiveMailbox(null);
    setOpenThread(null);
    setShowSettings(false);
    setShowCompose(false);
  };

  const openMailbox = (id: string) => {
    closeAllViews();
    setActiveMailbox(id);
  };

  const onAuthComplete = async () => {
    setAuthed(true);
    await refreshAccounts();
    // Switch to the newly added account (last in the list) and show split setup
    const accts = accounts();
    if (accts.length > 0) {
      const newAcct = accts[accts.length - 1];
      setActiveAccountId(newAcct.id);
      await invoke("save_setting", { key: "active_account_id", value: newAcct.id });
    }
    setNeedsSetup(true);
  };

  const onSetupComplete = async (chosen: SplitConfig[]) => {
    const accountId = activeAccountId();
    if (!accountId) return;
    setSplits(chosen);
    setNeedsSetup(false);
    await invoke("save_splits", { accountId, splits: chosen }).catch(console.error);
    const versionKey = `splits_version:${accountId}`;
    await invoke("save_setting", { key: versionKey, value: SPLITS_VERSION }).catch(console.error);
    if (chosen.length > 0) {
      setActiveTab(chosen[0].id);
      loadAllSplits();
      prefetchAllMailboxes();
      fetchInboxZeroPhoto();
    }
  };

  const threadIds = () => threads().map((t) => t.id);

  const selectAndOpen = (id: string) => {
    setSelectedId(id);
    const thread = threads().find((t) => t.id === id);
    if (thread) {
      setOpenThread({ id: thread.id, subject: thread.subject });
      if (!thread.isRead) markThreadRead(id);
    }
  };

  const markThreadRead = (threadId: string) => {
    // Optimistic: mark as read in all caches immediately
    setSplitThreads((prev) => {
      const next: Record<string, ThreadRow[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.map((t) => t.id === threadId ? { ...t, isRead: true } : t);
      }
      return next;
    });
    // Fire API call in background
    invoke("mark_thread_read", { threadId }).catch((e) =>
      console.error("Failed to mark read:", e)
    );
  };

  const navigateThread = (direction: 1 | -1) => {
    const ids = threadIds();
    if (ids.length === 0) return;
    const current = selectedId();
    const idx = current ? ids.indexOf(current) : -1;
    const next = idx + direction;
    if (next >= 0 && next < ids.length) selectAndOpen(ids[next]);
  };

  // Unified archive/trash: optimistic UI removal + Gmail API call
  const removeThread = async (
    threadId: string,
    action: "archive" | "trash" | "spam",
  ) => {
    const removedThread = threads().find((t) => t.id === threadId);

    const currentIds = threadIds();
    const currentIdx = currentIds.indexOf(threadId);
    let nextThread: OpenThread | null = null;
    if (currentIdx >= 0) {
      const nextId = currentIds[currentIdx + 1] ?? currentIds[currentIdx - 1];
      if (nextId) {
        const t = threads().find((th) => th.id === nextId);
        if (t) nextThread = { id: t.id, subject: t.subject };
      }
    }

    // Optimistic: remove from all split caches
    setSplitThreads((prev) => {
      const next: Record<string, ThreadRow[]> = {};
      for (const [key, list] of Object.entries(prev)) {
        next[key] = list.filter((t) => t.id !== threadId);
      }
      return next;
    });

    // Optimistic: add to target mailbox
    if (removedThread) {
      const targetMailbox = action === "archive" ? "done" : action === "trash" ? "bin" : "spam";
      setMailboxes((prev) => ({
        ...prev,
        [targetMailbox]: { ...prev[targetMailbox], threads: [removedThread, ...prev[targetMailbox].threads] },
      }));
    }

    // If viewing this thread, advance to next
    if (openThread()?.id === threadId) {
      setInlineReply(false);
      if (nextThread) {
        setOpenThread(nextThread);
        setSelectedId(nextThread.id);
      } else {
        setOpenThread(null);
        setSelectedId(null);
      }
    } else {
      if (nextThread) {
        setSelectedId(nextThread.id);
      } else {
        setSelectedId(null);
      }
    }

    const command = action === "archive" ? "archive_thread" : action === "trash" ? "trash_thread" : "spam_thread";
    try {
      await invoke(command, { threadId });
    } catch (e) {
      console.error(`${action} failed:`, e);
      loadAllSplits();
    }
  };

  const archiveThread = (threadId: string) => removeThread(threadId, "archive");
  const trashThread = (threadId: string) => removeThread(threadId, "trash");
  const spamThread = (threadId: string) => removeThread(threadId, "spam");

  const handleLogout = async () => {
    try {
      await invoke("logout");
      setAuthed(false);
      setAccounts([]);
      setActiveAccountId(null);
      setSplitThreads({});
      setMailboxes(
        Object.fromEntries(MAILBOX_DEFS.map((m) => [m.id, { threads: [], loading: false }]))
      );
      setSplits([]);
      setNeedsSetup(false);
      setOpenThread(null);
      setShowCompose(false);
      setShowSettings(false);
      setActiveMailbox(null);
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  const handleCommand = (id: string) => {
    const tid = () => openThread()?.id ?? selectedId();
    switch (id) {
      // Navigation
      case "inbox": setShowSettings(false); setShowCompose(false); setOpenThread(null); setActiveMailbox(null); break;
      case "done": openMailbox("done"); break;
      case "sent": openMailbox("sent"); break;
      case "drafts": openMailbox("drafts"); break;
      case "starred": openMailbox("starred"); break;
      case "all": openMailbox("all"); break;
      case "bin":
      case "trash-folder": openMailbox("bin"); break;
      case "spam-folder": openMailbox("spam"); break;
      case "settings": setShowSettings(true); break;
      case "shortcuts": setShowSettings(true); break;

      // Compose / reply
      case "compose": setComposeInitial(null); setShowCompose(true); break;
      case "reply":
        if (openThread()) { setReplyAll(false); setInlineReply(true); }
        break;
      case "reply-all":
        if (openThread()) { setReplyAll(true); setInlineReply(true); }
        break;
      case "forward": {
        const thread = openThread();
        if (thread) {
          setComposeInitial({ subject: `Fwd: ${thread.subject}` });
          setShowCompose(true);
        }
        break;
      }

      // Search
      case "search": setShowSearch(true); break;

      // Thread actions
      case "archive":
      case "mark-done": { const t = tid(); if (t) archiveThread(t); break; }
      case "delete":
      case "trash": { const t = tid(); if (t) trashThread(t); break; }
      case "spam": { const t = tid(); if (t) spamThread(t); break; }
      case "mark-unread": {
        const t = tid();
        if (t) {
          setSplitThreads((prev) => {
            const next: Record<string, ThreadRow[]> = {};
            for (const [key, list] of Object.entries(prev)) {
              next[key] = list.map((th) => th.id === t ? { ...th, isRead: false } : th);
            }
            return next;
          });
          invoke("mark_thread_unread", { threadId: t }).catch(console.error);
        }
        break;
      }
      case "star": {
        const t = tid();
        if (t) invoke("star_thread", { threadId: t, starred: true }).catch(console.error);
        break;
      }

      // Labels
      case "apply-label":
      case "remove-label":
      case "move-to":
        setLabelPickerMode(id as "apply-label" | "remove-label" | "move-to");
        break;

      // Organize
      case "create-split":
      case "edit-splits": setNeedsSetup(true); break;
      case "block-sender": {
        const t = tid();
        if (t) {
          const thread = threads().find((th) => th.id === t);
          if (thread?.fromEmail) {
            invoke("modify_thread_labels", {
              threadId: t,
              addLabelIds: ["SPAM"],
              removeLabelIds: ["INBOX"],
            }).catch(console.error);
            spamThread(t);
          }
        }
        break;
      }
      case "unsubscribe": {
        const t = tid();
        if (t) {
          invoke("get_unsubscribe_url", { threadId: t })
            .then((url) => { if (url) window.open(url as string, "_blank"); })
            .catch(console.error);
        }
        break;
      }

      // Other
      case "account": handleLogout(); break;
      case "download-eml": {
        const t = tid();
        const thread = openThread();
        if (t) {
          invoke<string>("download_eml", { threadId: t }).then((eml) => {
            const blob = new Blob([eml], { type: "message/rfc822" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${thread?.subject || "email"}.eml`;
            a.click();
            URL.revokeObjectURL(url);
          }).catch(console.error);
        }
        break;
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (e.key === "Escape") {
      if (showCompose()) { setShowCompose(false); return; }
      if (showSearch()) { setShowSearch(false); return; }
      if (showCommandBar()) { setShowCommandBar(false); return; }
      if (inlineReply()) { setInlineReply(false); setReplyAll(false); return; }
      if (showSettings()) { setShowSettings(false); return; }
      if (activeMailbox()) { setActiveMailbox(null); return; }
      if (openThread()) { setOpenThread(null); return; }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setShowCommandBar((v) => !v);
      return;
    }

    // Ctrl+1/2/3… to switch accounts
    if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key) - 1;
      const accs = accounts();
      if (idx < accs.length) {
        e.preventDefault();
        const target = idx === 0
          ? accs.find((a) => a.id === activeAccountId()) ?? accs[0]
          : accs.filter((a) => a.id !== activeAccountId())[idx - 1];
        if (target && target.id !== activeAccountId()) {
          switchAccount(target.id);
          setShowAccountPicker(false);
        }
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const s = splits();
      const tabIds = s.length > 0 ? s.map((sp) => sp.id) : ["inbox"];
      const idx = tabIds.indexOf(activeTab());
      const nextIdx = e.shiftKey
        ? (idx - 1 + tabIds.length) % tabIds.length
        : (idx + 1) % tabIds.length;
      loadSplit(tabIds[nextIdx]);
      return;
    }

    if (isInput) return;
    if (showCompose() || showSearch() || showCommandBar()) return;

    switch (e.key) {
      case "j": e.preventDefault(); navigateThread(1); break;
      case "k": e.preventDefault(); navigateThread(-1); break;
      case "Enter":
        e.preventDefault();
        if (!openThread() && selectedId()) selectAndOpen(selectedId()!);
        break;
      case "c":
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          setShowCompose(true);
        }
        break;
      case "r":
        if (openThread()) {
          e.preventDefault();
          setReplyAll(e.metaKey || e.ctrlKey);
          setInlineReply(true);
        }
        break;
      case "e": {
        e.preventDefault();
        const id = openThread()?.id ?? selectedId();
        if (id) archiveThread(id);
        else openMailbox("done");
        break;
      }
      case "s":
        e.preventDefault();
        if (!openThread()) openMailbox("sent");
        break;
      case "d":
        e.preventDefault();
        if (!openThread()) openMailbox("drafts");
        break;
      case "b":
        e.preventDefault();
        if (!openThread()) openMailbox("bin");
        break;
      case "!": {
        e.preventDefault();
        if (!openThread()) openMailbox("spam");
        break;
      }
      case "#": {
        e.preventDefault();
        const id = openThread()?.id ?? selectedId();
        if (id) trashThread(id);
        break;
      }
      case "/": e.preventDefault(); setShowSearch(true); break;
    }
  };

  onMount(() => {
    checkAuth();
    document.addEventListener("keydown", handleKeyDown);

    // Listen for background sync events from the Rust backend.
    // Debounce to avoid overlapping refetches when events arrive in quick succession.
    let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unlistenPromise = listen<{ eventType: string; changedThreadIds: string[] }>(
      "sync:update",
      (event) => {
        if (event.payload.changedThreadIds.length > 0) {
          if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
          syncDebounceTimer = setTimeout(() => {
            syncDebounceTimer = null;
            loadAllSplits();
          }, 300);
        }
      },
    );

    // Trigger immediate sync when app regains focus (e.g. after sleep/wake)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        invoke("trigger_sync").catch(console.error);
        loadAllSplits(); // Quick refresh from local cache
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    onCleanup(() => {
      unlistenPromise.then((fn) => fn());
      document.removeEventListener("visibilitychange", handleVisibility);
    });
  });
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <Show when={authed() !== null} fallback={
      <div class="h-screen w-screen bg-white" data-tauri-drag-region />
    }>
    <Show when={authed()} fallback={
      <Onboarding onComplete={onAuthComplete} />
    }>
    <Show when={!needsSetup()} fallback={
      <SplitSetup
        onComplete={onSetupComplete}
        currentSplits={splits()}
        onCancel={splits().length > 0 ? () => setNeedsSetup(false) : undefined}
      />
    }>
    <div class="h-screen w-screen text-zinc-900 flex overflow-hidden relative">
      {/* ── Inbox-zero full-bleed background ── */}
      <Show when={isInboxZero() && inboxZeroPhoto()}>
        <img
          src={inboxZeroPhoto()!.url}
          alt=""
          class="absolute inset-0 w-full h-full object-cover"
        />
        <div class="absolute inset-0 bg-black/10" />
        {/* Unsplash attribution */}
        <a
          href={inboxZeroPhoto()!.photographerUrl + "?utm_source=march&utm_medium=referral"}
          target="_blank"
          rel="noopener noreferrer"
          class="absolute bottom-2 right-3 z-20 text-[10px] text-white/50 hover:text-white/80 transition-colors"
        >
          Photo by {inboxZeroPhoto()!.photographer} on Unsplash
        </a>
      </Show>

      {/* ── Sidebar — transparent when inbox zero ── */}
      <aside class={`group/sidebar w-14 flex-shrink-0 flex flex-col items-center select-none relative z-10 transition-colors ${isInboxZero() ? "" : "bg-white"}`}>
        {/* Traffic light spacing — no border here */}
        <div class="h-12 flex-shrink-0" data-tauri-drag-region />

        {/* Border starts below traffic lights, runs to bottom */}
        <div class={`flex-1 w-full flex flex-col items-center ${isInboxZero() ? "" : "border-r border-zinc-200/60"}`}>
          {/* Account switcher — show active avatar, click to expand picker */}
          <div class="mt-1 flex flex-col items-center">
            <div
              class={`w-8 h-8 rounded-full overflow-hidden border flex items-center justify-center text-[11px] font-medium cursor-pointer transition-colors ${
                isInboxZero()
                  ? "border-white text-white bg-white/20"
                  : "border-zinc-800 text-zinc-800 bg-zinc-100"
              }`}
              title={activeAccount()?.email ?? "Switch account"}
              onClick={() => setShowAccountPicker((v) => !v)}
            >
              <Show when={activeAccount()?.avatarUrl && !avatarFailed()}>
                <img
                  src={activeAccount()!.avatarUrl!}
                  alt=""
                  class="w-full h-full object-cover"
                  onError={() => setAvatarFailed(true)}
                />
              </Show>
              <Show when={activeAccount() && (!activeAccount()?.avatarUrl || avatarFailed())}>
                <span>{String(getInitials(activeAccount()!))}</span>
              </Show>
            </div>
          </div>
          {/* Mailbox shortcuts — visible on sidebar hover */}
          <div class="mt-3 flex flex-col items-center space-y-3 opacity-0 group-hover/sidebar:opacity-100 transition-opacity"
            style="transition-duration: 150ms"
          >
            <SidebarIcon icon="done" label="done" onClick={() => openMailbox("done")} light={isInboxZero()} />
            <SidebarIcon icon="sent" label="sent" onClick={() => openMailbox("sent")} light={isInboxZero()} />
            <SidebarIcon icon="drafts" label="drafts" onClick={() => openMailbox("drafts")} light={isInboxZero()} />
            <SidebarIcon icon="bin" label="bin" onClick={() => openMailbox("bin")} light={isInboxZero()} />
            <SidebarIcon icon="spam" label="spam" onClick={() => openMailbox("spam")} light={isInboxZero()} />
          </div>
          <div class="flex-1" />
          {/* Search & config — always visible */}
          <div class="pb-4 space-y-3">
            <ShortcutHint hotkey="/" label="search" onClick={() => setShowSearch(true)} light={isInboxZero()} />
            <ShortcutHint hotkey="⌘K" label="config" onClick={() => setShowCommandBar(true)} light={isInboxZero()} />
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div class={`flex-1 flex flex-col min-w-0 relative z-10 ${isInboxZero() ? "" : "bg-white"}`}>
        {/* Nav: drag region + split inbox tabs (hidden when thread/compose open) */}
        <div class="flex-shrink-0" data-tauri-drag-region>
          <div class="h-10" data-tauri-drag-region />
          <Show when={!openThread() && !showCompose() && !showSettings() && !activeMailbox()}>
            <div class="flex items-center gap-0 px-20 pb-0" data-tauri-drag-region>
              <For each={splits().length > 0
                ? splits().map((s) => ({ id: s.id, label: s.name, gmailLabelId: s.gmailLabelId, query: s.query }))
                : [{ id: "inbox", label: "Inbox", gmailLabelId: undefined as string | undefined, query: undefined as string | undefined }]
              }>
                {(tab, i) => {
                  const count = () => threadCounts()[tab.id] ?? 0;
                  return (
                    <button
                      onClick={() => loadSplit(tab.id)}
                      class={`relative py-2.5 text-[14px] transition-colors ${i() === 0 ? "pr-3" : "px-3"} ${
                        activeTab() === tab.id
                          ? isInboxZero() ? "text-white font-medium" : "text-zinc-900 font-medium"
                          : isInboxZero() ? "text-white/60 hover:text-white/80" : "text-zinc-400 hover:text-zinc-600"
                      }`}
                    >
                      {tab.label}
                      <Show when={count() > 0}>
                        <span class={`ml-1.5 text-[12px] tabular-nums ${
                          isInboxZero()
                            ? activeTab() === tab.id ? "text-white/70" : "text-white/50"
                            : activeTab() === tab.id ? "text-zinc-500" : "text-zinc-400"
                        }`}>
                          {count()}
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex-1 relative overflow-hidden">
          <Show when={showSettings()} fallback={
          <Show when={activeMailbox()} fallback={
          <Show when={showCompose()} fallback={
            <Show when={openThread()} fallback={
              <Inbox
                threads={threads()}
                loading={loadingInbox()}
                selectedId={selectedId()}
                onSelect={selectAndOpen}
                onOpenThread={(t) => setOpenThread(t)}
                onArchive={archiveThread}
                onTrash={trashThread}
              />
            }>
              {(thread) => (
                <div class="flex h-full">
                  <div class="flex-1 min-w-0">
                    <ThreadView
                      threadId={thread().id}
                      subject={thread().subject}
                      onBack={() => { setOpenThread(null); setInlineReply(false); setReplyAll(false); }}
                      replyOpen={inlineReply()}
                      replyAll={replyAll()}
                      onReplyOpen={() => setInlineReply(true)}
                      onReplyClose={() => { setInlineReply(false); setReplyAll(false); }}
                    />
                  </div>
                  <div class="w-[260px] flex-shrink-0 overflow-y-auto">
                    <ContactSidebar threadId={thread().id} threads={threads()} />
                  </div>
                </div>
              )}
            </Show>
          }>
            <ComposeView onClose={() => { setShowCompose(false); setComposeInitial(null); }} initialSubject={composeInitial()?.subject} />
          </Show>
          }>
            {(mbId) => {
              const def = () => MAILBOX_DEFS.find((m) => m.id === mbId())!;
              const mb = () => mailboxes()[mbId()];
              return (
                <MailboxView
                  label={def().label}
                  emptyText={def().emptyText}
                  threads={mb().threads}
                  loading={mb().loading}
                  onBack={() => setActiveMailbox(null)}
                  onOpenThread={(thread) => {
                    setSelectedId(thread.id);
                    setOpenThread({ id: thread.id, subject: thread.subject });
                  }}
                />
              );
            }}
          </Show>
          }>
            <Settings
              onBack={() => setShowSettings(false)}
              onAccountsChanged={refreshAccounts}
              onNewAccount={async (accountId) => {
                setActiveAccountId(accountId);
                await invoke("save_setting", { key: "active_account_id", value: accountId });
                setShowSettings(false);
                setNeedsSetup(true);
              }}
            />
          </Show>
        </div>
      </div>

      {/* ── Overlays ── */}
      <Show when={showSearch()}>
        <SearchPalette
          onClose={() => setShowSearch(false)}
          onSelectThread={(id, subject) => {
            closeAllViews();
            setSelectedId(id);
            setOpenThread({ id, subject });
            markThreadRead(id);
          }}
        />
      </Show>
      <Show when={showCommandBar()}>
        <CommandPalette onClose={() => setShowCommandBar(false)} onCommand={handleCommand} />
      </Show>
      <Show when={labelPickerMode()}>
        {(mode) => {
          const tid = openThread()?.id ?? selectedId();
          return tid ? (
            <LabelPicker
              mode={mode()}
              threadId={tid}
              onClose={() => setLabelPickerMode(null)}
            />
          ) : null;
        }}
      </Show>
    </div>

    {/* Account picker dropdown — rendered outside sidebar to avoid overflow clipping */}
    <Show when={showAccountPicker()}>
      <div class="fixed inset-0 z-[100]" onClick={() => setShowAccountPicker(false)} />
      <div class="fixed left-[58px] top-[52px] z-[101] bg-zinc-800 rounded-lg shadow-xl border border-zinc-700 py-2 w-64">
        <div class="px-3 py-1.5 text-[11px] text-zinc-400 uppercase tracking-wider">Switch account</div>
        <For each={accounts()}>
          {(account) => {
            const isActive = () => account.id === activeAccountId();
            return (
              <button
                class={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                  isActive() ? "bg-zinc-700/50" : "hover:bg-zinc-700/30"
                }`}
                onClick={() => {
                  if (!isActive()) switchAccount(account.id);
                  setShowAccountPicker(false);
                }}
              >
                <div class={`w-8 h-8 rounded-full overflow-hidden border flex-shrink-0 flex items-center justify-center text-[11px] font-medium ${
                  isActive() ? "border-white/60 text-white" : "border-zinc-500 text-zinc-400"
                }`}>
                  {account.avatarUrl
                    ? <img src={account.avatarUrl} alt="" class="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).replaceWith(document.createTextNode(getInitials(account))); }} />
                    : getInitials(account)
                  }
                </div>
                <span class={`text-[13px] truncate ${isActive() ? "text-white" : "text-zinc-300"}`}>
                  {account.email}
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>

    </Show>
    </Show>
    </Show>
  );
}

/* ── Mailbox view ── */

function MailboxView(props: {
  label: string;
  emptyText: string;
  threads: ThreadRow[];
  loading: boolean;
  onBack: () => void;
  onOpenThread: (thread: ThreadRow) => void;
}) {
  return (
    <div class="absolute inset-0 overflow-y-auto pt-3 pb-12">
      <div class="flex items-center gap-2 px-20 mb-4">
        <button onClick={props.onBack} class="text-zinc-400 hover:text-zinc-600 transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 12L6 8l4-4" />
          </svg>
        </button>
        <span class="text-[15px] font-medium text-zinc-900">{props.label}</span>
      </div>
      <Show when={!props.loading} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">Loading…</div>
      }>
      <Show when={props.threads.length > 0} fallback={
        <div class="flex items-center justify-center h-32 text-[13px] text-zinc-400">{props.emptyText}</div>
      }>
        <For each={props.threads}>
          {(thread) => (
            <div
              class="group flex items-center gap-3 px-20 py-2.5 cursor-pointer hover:bg-zinc-50"
              onClick={() => props.onOpenThread(thread)}
            >
              <div class="w-40 flex-shrink-0 truncate">
                <span class="text-[13px] text-zinc-500">{thread.fromName}</span>
              </div>
              <div class="flex-1 min-w-0 truncate">
                <span class="text-[13px] text-zinc-400">{thread.subject}</span>
              </div>
              <div class="text-[12px] text-zinc-400 tabular-nums">{thread.date}</div>
            </div>
          )}
        </For>
      </Show>
      </Show>
    </div>
  );
}

/* ── Sidebar icon ── */

function SidebarIcon(props: { icon: string; label: string; onClick?: () => void; light?: boolean }) {
  const icons: Record<string, () => any> = {
    done: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3.5 8l3 3 6-6" />
      </svg>
    ),
    sent: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2L7 9" />
        <path d="M14 2l-4 12-3-5-5-3z" />
      </svg>
    ),
    drafts: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 00-2 2v7a2 2 0 002 2h8a2 2 0 002-2V8" />
        <path d="M10.5 1.5l2 2L8 8H6V6l4.5-4.5z" />
      </svg>
    ),
    bin: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4" />
      </svg>
    ),
    spam: () => (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5.24 1.33 10.76 1.33 14.67 5.24 14.67 10.76 10.76 14.67 5.24 14.67 1.33 10.76 1.33 5.24" />
        <line x1="8" y1="5.33" x2="8" y2="8" />
        <line x1="8" y1="10.67" x2="8.01" y2="10.67" />
      </svg>
    ),
  };
  const Icon = icons[props.icon];
  return (
    <button
      onClick={props.onClick}
      class="flex flex-col items-center gap-0.5 group cursor-pointer"
    >
      <div class={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
        props.light ? "text-white/70 group-hover:text-white" : "text-zinc-400 group-hover:text-zinc-600"
      }`}>
        {Icon ? <Icon /> : null}
      </div>
      <span class={`text-[9px] transition-colors ${
        props.light ? "text-white/60 group-hover:text-white/80" : "text-zinc-400 group-hover:text-zinc-600"
      }`}>{props.label}</span>
    </button>
  );
}

/* ── Shortcut hint ── */

function ShortcutHint(props: { hotkey: string; label: string; onClick?: () => void; light?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      class="flex flex-col items-center gap-0.5 group cursor-pointer"
    >
      <kbd class={`w-7 h-7 rounded-md border flex items-center justify-center text-[11px] font-mono transition-colors ${
        props.light
          ? "bg-transparent border-white/25 text-white/70 group-hover:border-white/40 group-hover:text-white"
          : "bg-white border-zinc-200 text-zinc-400 shadow-sm group-hover:border-zinc-300 group-hover:text-zinc-600"
      }`}>
        {props.hotkey}
      </kbd>
      <span class={`text-[9px] transition-colors ${
        props.light ? "text-white/60 group-hover:text-white/80" : "text-zinc-400 group-hover:text-zinc-600"
      }`}>{props.label}</span>
    </button>
  );
}

/* ── Contact sidebar ── */

function ContactSidebar(props: { threadId: string; threads: ThreadRow[] }) {
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
