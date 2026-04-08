import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";

interface CalendarEventDto {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  description: string | null;
  calendarName: string | null;
  color: string | null;
  organizerEmail: string | null;
  attendees: string[] | null;
  isAllDay: boolean;
}

interface DayGroup {
  label: string;
  date: string;
  events: CalendarEventDto[];
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${m.toString().padStart(2, "0")} ${suffix}`;
}

function formatRelative(isoStr: string): string {
  const now = Date.now();
  const target = new Date(isoStr).getTime();
  const diffMs = target - now;
  if (diffMs <= 0) return "now";

  const totalMins = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;

  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function getDayLabel(dateStr: string): string {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";

  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function groupByDay(events: CalendarEventDto[]): DayGroup[] {
  const groups = new Map<string, CalendarEventDto[]>();

  for (const ev of events) {
    const dateStr = ev.isAllDay
      ? ev.startTime.slice(0, 10)
      : new Date(ev.startTime).toISOString().slice(0, 10);
    if (!groups.has(dateStr)) groups.set(dateStr, []);
    groups.get(dateStr)!.push(ev);
  }

  const sorted = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([date, events]) => ({
    label: getDayLabel(date),
    date,
    events,
  }));
}

export default function MenubarCalendar() {
  const [events, setEvents] = createSignal<CalendarEventDto[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [nextEvent, setNextEvent] = createSignal<CalendarEventDto | null>(null);

  const dayGroups = () => groupByDay(events());

  async function fetchEvents() {
    try {
      // Get upcoming events — we pass empty string for account_id to signal "all accounts"
      // The backend get_upcoming_events needs an account_id, so we use get_next_event
      // and fetch the upcoming events differently.
      // For the popup, we'll fetch from the first active account or all.
      const result = await invoke<CalendarEventDto[]>("get_upcoming_events", {
        accountId: "_all",
        days: 7,
      });
      setEvents(result);
    } catch (e) {
      console.warn("Failed to fetch calendar events:", e);
      setEvents([]);
    }

    try {
      const next = await invoke<CalendarEventDto | null>("get_next_event");
      setNextEvent(next);
    } catch {
      setNextEvent(null);
    }

    setLoading(false);
  }

  onMount(() => {
    fetchEvents();
  });

  // Re-fetch when backend signals new calendar data
  const unlistenUpdated = listen("calendar:events_updated", () => fetchEvents());
  const unlistenPopup = listen("calendar:popup_opened", () => fetchEvents());
  onCleanup(() => {
    unlistenUpdated.then((fn) => fn());
    unlistenPopup.then((fn) => fn());
  });

  return (
    <div class="w-full h-full bg-white flex flex-col overflow-hidden select-none" style="font-family: system-ui, -apple-system, sans-serif">
      {/* Header */}
      <div class="px-4 pt-3 pb-2 border-b border-zinc-100">
        <Show when={nextEvent()} fallback={
          <div class="text-[13px] text-zinc-400">No upcoming events</div>
        }>
          {(ev) => (
            <div>
              <div class="text-[13px] font-medium text-zinc-700 truncate">{ev().title}</div>
              <div class="text-[11px] text-zinc-400 mt-0.5">
                Upcoming {formatRelative(ev().startTime)}
              </div>
            </div>
          )}
        </Show>
      </div>

      {/* Event list */}
      <div class="flex-1 overflow-y-auto px-4 py-2">
        <Show when={!loading()} fallback={
          <div class="text-[12px] text-zinc-400 py-4 text-center">Loading...</div>
        }>
          <Show when={events().length > 0} fallback={
            <div class="text-[12px] text-zinc-400 py-4 text-center">No upcoming events</div>
          }>
            <For each={dayGroups()}>
              {(group) => (
                <div class="mb-3">
                  <div class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                    {group.label}
                  </div>
                  <For each={group.events}>
                    {(ev) => (
                      <div class="flex items-start gap-2.5 py-1.5 px-1 rounded hover:bg-zinc-50 cursor-default">
                        <div
                          class="w-1 h-full min-h-[20px] rounded-full flex-shrink-0 mt-0.5"
                          style={{ "background-color": ev.color || "#3b82f6" }}
                        />
                        <div class="flex-1 min-w-0">
                          <div class="text-[13px] text-zinc-700 truncate">{ev.title}</div>
                          <div class="text-[11px] text-zinc-400">
                            {ev.isAllDay ? "All day" : `${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`}
                            <Show when={ev.location}>
                              <span class="ml-1.5">· {ev.location}</span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      {/* Footer */}
      <div class="px-4 py-2.5 border-t border-zinc-100 flex items-center justify-between">
        <span class="text-[11px] font-medium text-zinc-400">morphis</span>
        <div class="flex items-center gap-3">
          <button
            onClick={() => exit(0)}
            class="text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
