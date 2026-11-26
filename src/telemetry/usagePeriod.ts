/**
 * The landing page's usage periods: where each one starts.
 *
 * Inlined into the page's script the profileSort.ts / freeResets.ts way: the
 * table through JSON.stringify, the function through `.toString()`, so
 * periodStart must reference nothing outside its own body
 * (usage-period.test.ts).
 */

export type UsagePeriod = "today" | "week" | "month" | "24h"
export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string; title: string }> = [
  { id: "today", label: "Today", title: "Since midnight" },
  { id: "week", label: "This week", title: "Since Monday 00:00" },
  { id: "month", label: "This month", title: "Since the 1st" },
  { id: "24h", label: "Last 24h", title: "Rolling 24 hours" },
]
/** Epoch ms where `period` starts, in the runtime's local zone. Week starts Monday. */
export function periodStart(period: string, nowMs: number): number {
  if (period === "24h") return nowMs - 86400000
  const d = new Date(nowMs)
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (period === "week" ? (d.getDay() + 6) % 7 : 0)).getTime()
}
