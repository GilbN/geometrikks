const INTERVAL_TRIGGER = /^interval\[(?:(\d+) days?, )?(\d+):(\d{2}):(\d{2})\]$/

const UNITS: Array<[string, number]> = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
]

/** Turns APScheduler's `interval[7 days, 0:00:00]` into "Every 7 days".
 * Cron and date triggers, and anything else it can't read, come back unchanged. */
export function describeTrigger(trigger: string): string {
  const match = INTERVAL_TRIGGER.exec(trigger)
  if (!match) return trigger
  const [, days, hours, minutes, seconds] = match
  const total =
    Number(days ?? 0) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds)
  if (total === 0) return trigger
  const [unit, size] = UNITS.find(([, unitSeconds]) => total % unitSeconds === 0) ?? UNITS[3]
  const count = total / size
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`
}
