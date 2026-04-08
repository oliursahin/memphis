import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import ThreadView from "./pages/Thread";
import ComposeView from "./pages/Compose";
import MailboxView from "./pages/Mailbox";
import SearchPalette from "./components/SearchPalette";
import CommandPalette from "./components/CommandPalette";
import LabelPicker from "./components/LabelPicker";
import Sidebar from "./components/Sidebar";
import HeaderBar from "./components/HeaderBar";
import ContactSidebar from "./components/ContactSidebar";
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

export interface AppAccount {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
  isActive: boolean;
}

export interface MailboxDef {
  id: string;
  label: string;
  query: string;
  emptyText: string;
}

interface OpenThread {
  id: string;
  subject: string;
}

interface InboxResponse {
  threads: ThreadRow[];
  nextPageToken: string | null;
}

export const MAILBOX_DEFS: readonly MailboxDef[] = [
  { id: "done", label: "Done", query: "-in:inbox -in:trash -in:spam", emptyText: "No archived emails" },
  { id: "sent", label: "Sent", query: "in:sent", emptyText: "No sent emails" },
  { id: "drafts", label: "Drafts", query: "in:drafts", emptyText: "No drafts" },
  { id: "bin", label: "Bin", query: "in:trash", emptyText: "Bin is empty" },
  { id: "spam", label: "Spam", query: "in:spam", emptyText: "No spam" },
  { id: "starred", label: "Starred", query: "is:starred", emptyText: "No starred emails" },
  { id: "all", label: "All Mail", query: "-in:spam -in:trash", emptyText: "No emails" },
];

export default function App() {
  const [authed, setAuthed] = createSignal<boolean | null>(null); // null = loading
  const [accounts, setAccounts] = createSignal<AppAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = createSignal<string | null>(null);
  const [needsSetup, setNeedsSetup] = createSignal(false);
  const [splits, setSplits] = createSignal<SplitConfig[]>([]);
  const [allAccountSplits, setAllAccountSplits] = createSignal<Record<string, SplitConfig[]>>({});

  // Per-split thread cache — switching tabs is instant
  const [splitThreads, setSplitThreads] = createSignal<Record<string, ThreadRow[]>>({});
  const [loadingSplits, setLoadingSplits] = createSignal<Set<string>>(new Set());

  // Derived from cache
  const threads = () => splitThreads()[activeTab()] ?? [];
  const loadingInbox = () => loadingSplits().has(activeTab());

  const activeAccount = createMemo(() => accounts().find((a) => a.id === activeAccountId()));

  // Track avatar load failures so we fall back to initials
  const [avatarFailed, setAvatarFailed] = createSignal(false);

  // "g" prefix shortcut state — pressing "g" then a second key navigates to a mailbox
  let pendingG = false;
  let pendingGTimeout: ReturnType<typeof setTimeout> | undefined;

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
  const [composeInitial, setComposeInitial] = createSignal<{ subject?: string; to?: string; body?: string; bodyHtml?: string; cc?: string; bcc?: string } | null>(null);
  const [composeSplitId, setComposeSplitId] = createSignal<string | null>(null); // which split compose was opened from
  const [lastDraftData, setLastDraftData] = createSignal<{ to: string; subject: string; body: string; bodyHtml?: string; cc?: string; bcc?: string } | null>(null); // stash draft data for re-opening
  const [labelPickerMode, setLabelPickerMode] = createSignal<"apply-label" | "remove-label" | "move-to" | null>(null);
  const [showSearch, setShowSearch] = createSignal(false);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [showCommandBar, setShowCommandBar] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [inlineReply, setInlineReply] = createSignal(false);
  const [replyAll, setReplyAll] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);

  // Auto-update state
  const [updateAvailable, setUpdateAvailable] = createSignal<{ version: string; install: () => Promise<void> } | null>(null);
  const [updateInstalling, setUpdateInstalling] = createSignal(false);

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
      setAllAccountSplits((prev) => ({ ...prev, [accountId]: saved }));
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
        // Pre-load splits for all other accounts so sidebar shows them
        for (const acct of accounts()) {
          if (acct.id !== accountId) {
            const saved = await invoke<SplitConfig[]>("get_splits", { accountId: acct.id }).catch(() => []);
            if (saved.length > 0) {
              setAllAccountSplits((prev) => ({ ...prev, [acct.id]: saved }));
            }
          }
        }
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

      const prev = splitThreads();
      const newSplitThreads: Record<string, ThreadRow[]> = {};
      for (const split of allSplits) {
        const filtered = filterThreadsForSplit(allThreads, split, allSplits);
        // Preserve local draft placeholders through refetch (scoped by ID prefix to avoid matching real Gmail drafts)
        const drafts = (prev[split.id] ?? []).filter((t) => t.id.startsWith("draft-"));
        newSplitThreads[split.id] = [...drafts, ...filtered];
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

  // Open compose and immediately insert a draft placeholder into the active split
  const openCompose = (opts?: { subject?: string; to?: string; body?: string; cc?: string; bcc?: string }) => {
    const tab = activeTab();
    setComposeSplitId(tab);
    setComposeInitial(opts ?? null);
    setOpenThread(null);
    setShowCompose(true);

    // Insert placeholder draft entry into the split right now
    const draftThread: ThreadRow = {
      id: `draft-compose-${Date.now()}`,
      subject: opts?.subject || "(no subject)",
      snippet: opts?.body?.slice(0, 100) || "",
      fromName: opts?.to || "Me",
      fromEmail: "",
      date: "Draft",
      isRead: true,
      messageCount: 1,
      labelIds: ["DRAFT"],
    };

    setSplitThreads((prev) => {
      const existing = prev[tab] ?? [];
      // Replace existing draft or prepend
      const idx = existing.findIndex((t) => t.labelIds?.includes("DRAFT"));
      if (idx >= 0) {
        const next = [...existing];
        next[idx] = draftThread;
        return { ...prev, [tab]: next };
      }
      return { ...prev, [tab]: [draftThread, ...existing] };
    });

    // Also add to drafts mailbox
    setMailboxes((prev) => {
      const draftsBox = prev["drafts"] ?? { threads: [], loading: false };
      const existing = draftsBox.threads;
      const idx = existing.findIndex((t) => t.labelIds?.includes("DRAFT"));
      if (idx >= 0) {
        const next = [...existing];
        next[idx] = draftThread;
        return { ...prev, drafts: { ...draftsBox, threads: next } };
      }
      return { ...prev, drafts: { ...draftsBox, threads: [draftThread, ...existing] } };
    });
  };

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
      case "compose": openCompose(); break;
      case "reply":
        if (openThread()) { setReplyAll(false); setInlineReply(true); }
        break;
      case "reply-all":
        if (openThread()) { setReplyAll(true); setInlineReply(true); }
        break;
      case "forward": {
        const thread = openThread();
        if (thread) {
          openCompose({ subject: `Fwd: ${thread.subject}` });
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
      const target = accs[idx];
      if (target && target.id !== activeAccountId()) {
        e.preventDefault();
        switchAccount(target.id);
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      // Build flat list of all splits across all accounts
      const allEntries: { accountId: string; splitId: string }[] = [];
      for (const acct of accounts()) {
        const acctSplits = acct.id === activeAccountId()
          ? splits()
          : (allAccountSplits()[acct.id] ?? []);
        for (const sp of acctSplits) {
          allEntries.push({ accountId: acct.id, splitId: sp.id });
        }
      }
      if (allEntries.length === 0) return;
      const rawIdx = allEntries.findIndex(
        (entry) => entry.accountId === activeAccountId() && entry.splitId === activeTab()
      );
      const currentIdx = rawIdx === -1 ? 0 : rawIdx;
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + allEntries.length) % allEntries.length
        : (currentIdx + 1) % allEntries.length;
      const next = allEntries[nextIdx];
      if (next.accountId !== activeAccountId()) {
        switchAccount(next.accountId).then(() => loadSplit(next.splitId));
      } else {
        loadSplit(next.splitId);
      }
      return;
    }

    if (isInput) return;
    if (showCompose() || showSearch() || showCommandBar()) return;

    // "g" prefix shortcuts — press g then a second key to navigate
    if (pendingG) {
      pendingG = false;
      clearTimeout(pendingGTimeout);
      const nav: Record<string, string | null> = {
        i: null, e: "done", t: "sent", d: "drafts",
        b: "bin", s: "starred", a: "all",
      };
      if (e.key === "!" || e.key in nav) {
        e.preventDefault();
        if (e.key === "!") { openMailbox("spam"); }
        else if (nav[e.key] === null) { setActiveMailbox(null); }
        else { openMailbox(nav[e.key]!); }
        return;
      }
      // Unrecognised second key — fall through to normal handling
    }

    if (e.key === "g" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      pendingG = true;
      clearTimeout(pendingGTimeout);
      pendingGTimeout = setTimeout(() => { pendingG = false; }, 1500);
      return;
    }

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
          openCompose();
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

    // Check for app updates
    check().then((update) => {
      if (update) {
        setUpdateAvailable({
          version: update.version,
          install: async () => {
            setUpdateInstalling(true);
            await update.downloadAndInstall();
            await relaunch();
          },
        });
      }
    }).catch(console.error);

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
      {/* ── Update banner ── */}
      <Show when={updateAvailable()}>
        {(update) => (
          <div class="absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-3 bg-black text-white text-[13px] py-2 px-4">
            <span>Morphis {update().version} is available</span>
            <button
              onClick={() => update().install()}
              disabled={updateInstalling()}
              class="bg-white text-black px-3 py-0.5 rounded-md text-[12px] font-medium hover:bg-white/90 disabled:opacity-50"
            >
              {updateInstalling() ? "Installing…" : "Update & restart"}
            </button>
          </div>
        )}
      </Show>

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

      {/* ── Sidebar ── */}
      <Show when={!sidebarCollapsed()}>
        <Sidebar
          accounts={accounts}
          activeAccountId={activeAccountId}
          activeAccount={activeAccount}
          avatarFailed={avatarFailed}
          onAvatarError={() => setAvatarFailed(true)}
          onSwitchAccount={switchAccount}
          splits={splits}
          activeTab={activeTab}
          threadCounts={threadCounts}
          onLoadSplit={loadSplit}
          activeMailbox={activeMailbox}
          onOpenMailbox={openMailbox}
          mailboxDefs={MAILBOX_DEFS}
          onShowSearch={() => setShowSearch(true)}
          onShowCommandBar={() => setShowCommandBar(true)}
          isInboxZero={isInboxZero}
          onCollapse={() => setSidebarCollapsed(true)}
          allAccountSplits={allAccountSplits}
        />
      </Show>

      {/* ── Main content ── */}
      <div class={`flex-1 flex min-w-0 relative z-10 ${isInboxZero() ? "" : "bg-white"}`}>
      <div class="flex-1 flex flex-col min-w-0">
        <HeaderBar
          activeAccount={activeAccount}
          activeTab={activeTab}
          activeMailbox={activeMailbox}
          openThread={openThread}
          showCompose={showCompose}
          showSettings={showSettings}
          splits={splits}
          mailboxDefs={MAILBOX_DEFS}
          onBack={() => {
            if (showCompose()) { setShowCompose(false); return; }
            if (showSettings()) { setShowSettings(false); return; }
            if (openThread()) { setOpenThread(null); setInlineReply(false); setReplyAll(false); return; }
            if (activeMailbox()) { setActiveMailbox(null); return; }
          }}
          isInboxZero={isInboxZero}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />

        <div class="flex-1 relative overflow-hidden">
          <Show when={showSettings()} fallback={
          <Show when={openThread()} fallback={
          <Show when={activeMailbox()} fallback={
          <Show when={showCompose()} fallback={
              <Inbox
                threads={threads()}
                loading={loadingInbox()}
                selectedId={selectedId()}
                onSelect={selectAndOpen}
                onOpenThread={(t) => setOpenThread(t)}
                onArchive={archiveThread}
                onTrash={trashThread}
                onCompose={() => {
                  const draft = lastDraftData();
                  openCompose(draft ?? undefined);
                }}
              />
          }>
            <ComposeView
              onClose={() => {
                setShowCompose(false);
                setComposeInitial(null);
                setComposeSplitId(null);
              }}
              onSent={() => {
                // Remove draft entries from splits and mailboxes after sending
                setLastDraftData(null);
                setSplitThreads((prev) => {
                  const next: Record<string, ThreadRow[]> = {};
                  for (const [key, threads] of Object.entries(prev)) {
                    next[key] = threads.filter((t) => !t.labelIds?.includes("DRAFT"));
                  }
                  return next;
                });
                setMailboxes((prev) => {
                  const draftsBox = prev["drafts"];
                  if (!draftsBox) return prev;
                  return { ...prev, drafts: { ...draftsBox, threads: draftsBox.threads.filter((t) => !t.labelIds?.includes("DRAFT")) } };
                });
              }}
              initialSubject={composeInitial()?.subject}
              initialTo={composeInitial()?.to}
              initialBody={composeInitial()?.body}
              initialBodyHtml={composeInitial()?.bodyHtml}
              initialCc={composeInitial()?.cc}
              initialBcc={composeInitial()?.bcc}
              onDraftSaved={(draft) => {
                // Stash full draft data so it can be restored if re-opened
                setLastDraftData({ to: draft.to, subject: draft.subject, body: draft.body, bodyHtml: draft.bodyHtml, cc: draft.cc, bcc: draft.bcc });

                const draftThread: ThreadRow = {
                  id: `draft-${draft.id}`,
                  subject: draft.subject,
                  snippet: draft.snippet,
                  fromName: draft.to || "Me",
                  fromEmail: "",
                  date: "Draft",
                  isRead: true,
                  messageCount: 1,
                  labelIds: ["DRAFT"],
                };

                // Update draft in the split where compose was opened
                const tab = composeSplitId() || activeTab();
                setSplitThreads((prev) => {
                  const existing = prev[tab] ?? [];
                  const idx = existing.findIndex((t) => t.labelIds?.includes("DRAFT"));
                  if (idx >= 0) {
                    const next = [...existing];
                    next[idx] = draftThread;
                    return { ...prev, [tab]: next };
                  }
                  return { ...prev, [tab]: [draftThread, ...existing] };
                });

                // Also update in the drafts mailbox
                setMailboxes((prev) => {
                  const draftsBox = prev["drafts"] ?? { threads: [], loading: false };
                  const existing = draftsBox.threads;
                  const idx = existing.findIndex((t) => t.labelIds?.includes("DRAFT"));
                  if (idx >= 0) {
                    const next = [...existing];
                    next[idx] = draftThread;
                    return { ...prev, drafts: { ...draftsBox, threads: next } };
                  }
                  return { ...prev, drafts: { ...draftsBox, threads: [draftThread, ...existing] } };
                });
              }}
            />
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
                  onOpenThread={(thread) => {
                    setSelectedId(thread.id);
                    setOpenThread({ id: thread.id, subject: thread.subject });
                  }}
                  onCompose={() => {
                    const draft = lastDraftData();
                    setActiveMailbox(null);
                    openCompose(draft ?? undefined);
                  }}
                />
              );
            }}
          </Show>
          }>
            {(thread) => (
              <ThreadView
                threadId={thread().id}
                subject={thread().subject}
                onBack={() => { setOpenThread(null); setInlineReply(false); setReplyAll(false); }}
                replyOpen={inlineReply()}
                replyAll={replyAll()}
                onReplyOpen={() => setInlineReply(true)}
                onReplyClose={() => { setInlineReply(false); setReplyAll(false); }}
              />
            )}
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

      {/* ── Contact sidebar — spans full height, outside header column ── */}
      <Show when={openThread()}>
        {(thread) => (
          <div class="w-[260px] flex-shrink-0 overflow-y-auto border-l border-zinc-200">
            <ContactSidebar threadId={thread().id} threads={threads()} />
          </div>
        )}
      </Show>
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

    </Show>
    </Show>
    </Show>
  );
}
