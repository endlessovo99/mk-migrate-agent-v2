const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

export const DEFAULT_SCHEDULE = Object.freeze({
  weekday: Object.freeze([
    Object.freeze({ id: "weekday-day", start: "07:00", end: "19:00", batchSize: 10, intervalMinutes: 20 }),
    Object.freeze({ id: "weekday-night", start: "19:00", end: "07:00", batchSize: 20, intervalMinutes: 15 })
  ]),
  weekend: Object.freeze([
    Object.freeze({ id: "weekend", start: "00:00", end: "24:00", batchSize: 20, intervalMinutes: 15 })
  ])
});

function check(value, message) { if (!value) throw new Error(message); }
function minuteOfDay(value, end = false) {
  check(typeof value === "string" && (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) || (end && value === "24:00")), "Window times must be HH:MM; 24:00 is allowed only as an end");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function validateSchedule(schedule) {
  check(schedule && typeof schedule === "object" && !Array.isArray(schedule) && Object.keys(schedule).every((key) => ["weekday", "weekend"].includes(key)), "Invalid schedule object");
  const ids = new Set();
  for (const group of ["weekday", "weekend"]) {
    check(Array.isArray(schedule[group]) && schedule[group].length <= 24, `schedule.${group} must contain at most 24 windows`);
    const ranges = [];
    for (const window of schedule[group]) {
      check(window && typeof window === "object" && Object.keys(window).every((key) => ["id", "start", "end", "batchSize", "intervalMinutes"].includes(key)), "Invalid schedule window");
      check(typeof window.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(window.id) && !ids.has(window.id), "Window ids must be unique");
      ids.add(window.id);
      const start = minuteOfDay(window.start), end = minuteOfDay(window.end, true);
      check(start !== end, "Empty or ambiguous window; use 00:00–24:00 for a full day");
      for (const [key, max] of [["batchSize", 200], ["intervalMinutes", 1440]])
        check(Number.isInteger(window[key]) && window[key] >= 1 && window[key] <= max, `${key} must be an integer from 1 to ${max}`);
      if (start < end) ranges.push([start, end]);
      else { ranges.push([start, 1440]); if (end > 0) ranges.push([0, end]); }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index++) check(ranges[index][0] >= ranges[index - 1][1], `Overlapping ${group} windows`);
  }
  return schedule;
}

export function shanghaiMinute(now) {
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return { parts, slot: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` };
}

/** Slots are calendar-aligned. Missed slots are never caught up in a burst. */
export function scheduleAt(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  validateSchedule(schedule);
  const { parts, slot } = shanghaiMinute(now);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekend = ["Sat", "Sun"].includes(parts.weekday);
  for (const window of schedule[weekend ? "weekend" : "weekday"]) {
    const start = minuteOfDay(window.start), end = minuteOfDay(window.end, true);
    const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
    if (inside) return { timeZone: "Asia/Shanghai", mode: window.id, batchSize: window.batchSize, intervalMinutes: window.intervalMinutes,
      due: ((minute - start + 1440) % 1440) % window.intervalMinutes === 0, slot, start: window.start, end: window.end };
  }
  return { timeZone: "Asia/Shanghai", mode: "outside-window", batchSize: 0, intervalMinutes: null, due: false, slot };
}

export function admission(config, { active, availableMemoryMB, freeDiskMB }, batchSize) {
  if (freeDiskMB < config.minFreeDiskMB) return { count: 0, reason: "disk_reserve" };
  const memorySlots = Math.max(0, Math.floor((availableMemoryMB - config.minAvailableMemoryMB) / config.estimatedSessionMemoryMB));
  const count = Math.max(0, Math.min(batchSize, config.maxSessions - active, memorySlots));
  return { count, reason: count ? "capacity_available" : memorySlots === 0 ? "memory_reserve" : "session_limit" };
}
