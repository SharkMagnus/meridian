import { afterAll, beforeAll, expect, test } from "bun:test"
import { landingHtml } from "../telemetry/landing"
import { periodStart } from "../telemetry/usagePeriod"

// The form the page runs: the function's own source, with nothing around it.
const pageStart = new Function(`return (${periodStart.toString()})`)() as typeof periodStart

// Never `delete process.env.TZ`: on bun 1.3.14 later assignments are then ignored.
const saved = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
beforeAll(() => { process.env.TZ = "Europe/Copenhagen" })
afterAll(() => { process.env.TZ = saved })

const start = (period: string, now: string) => new Date(pageStart(period, Date.parse(now))).toISOString()

test("a Sunday on which the clocks went forward starts its day, week and month in winter time", () => {
  const now = "2026-03-29T10:00:00Z"
  expect(start("today", now)).toBe("2026-03-28T23:00:00.000Z")
  expect(start("week", now)).toBe("2026-03-22T23:00:00.000Z")
  expect(start("month", now)).toBe("2026-02-28T23:00:00.000Z")
})

test("half past midnight on Monday the 1st starts all three at that midnight", () => {
  const now = "2026-05-31T22:30:00Z"
  expect(start("today", now)).toBe("2026-05-31T22:00:00.000Z")
  expect(start("week", now)).toBe("2026-05-31T22:00:00.000Z")
  expect(start("month", now)).toBe("2026-05-31T22:00:00.000Z")
})

test("a week can begin in the previous year", () => {
  const now = "2027-01-01T11:00:00Z"
  expect(start("today", now)).toBe("2026-12-31T23:00:00.000Z")
  expect(start("week", now)).toBe("2026-12-27T23:00:00.000Z")
  expect(start("month", now)).toBe("2026-12-31T23:00:00.000Z")
})

test("Last 24h is the 24 hours before now", () => {
  const now = Date.parse("2026-03-29T10:00:00Z")
  expect(pageStart("24h", now)).toBe(now - 86400000)
})

test("the page inlines this function and starts on Today", () => {
  expect(landingHtml).toContain("var periodStart=" + periodStart.toString() + ";")
  expect(landingHtml).toContain('var viewPeriod="today"')
})
