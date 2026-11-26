import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { periodStart } from "../telemetry/usagePeriod"

type Move = { delta: number } | null
type Page = {
  noteRead(now: number, ok: boolean): void
  trackMove(key: string, v: number | null, now: number): Move
  movedText(m: Move, now: number): string
  flashClass(m: Move): string
  clockHtml(now: number): string
  readPlan(id: string, now: number): { key: string; url: string }
  enterWindow(key: string): void
}

// The page's own definitions, run as the browser runs them.
function page(): Page {
  const line = (name: string) => {
    const source = landingHtml.match(new RegExp(`^(?:function|var) ${name}\\b.*$`, "m"))?.[0]
    if (!source) throw new Error(`Missing rendered page definition ${name}`)
    return source
  }
  const context = {} as Page
  const names = ["usd", "span", "moved", "noteRead", "trackMove", "movedText", "flashClass", "clockHtml", "viewPeriod", "readPlan", "enterWindow"]
  runInNewContext(`var periodStart=${periodStart.toString()};\n` + names.map(line).join("\n"), context)
  return context
}
const text = (html: string) => html.replace(/<[^>]*>/g, "")

type Fetch = (url: string) => Promise<{ json(): Promise<unknown> }>

// The page's refresh() over the figures it last drew; by default every read fails.
function pageRefresh(lastData: unknown[] | null, fetch: Fetch = () => Promise.reject(new Error("fixture unavailable"))) {
  const line = (name: string) => landingHtml.match(new RegExp(`^(?:function|var) ${name}\\b.*$`, "m"))![0]
  const content = { innerHTML: "the page as last drawn" }
  const drawn: unknown[][] = []
  const source = `var periodStart=${periodStart.toString()};\n`
    + ["moved", "span", "noteRead", "replayMarks", "viewPeriod", "readPlan", "enterWindow"].map(line).join("\n")
    + `\nvar lastData=${JSON.stringify(lastData)};\nfunction infoPopOpen(){return false}\n`
    + landingHtml.slice(landingHtml.indexOf("async function refresh(){"), landingHtml.indexOf("function tokens(v)"))
  const refresh = new Function("document", "fetch", "render", "meridianReorder", source + "\nreturn refresh;")(
    { getElementById: () => content, querySelectorAll: () => [] },
    fetch,
    (...data: unknown[]) => { drawn.push(data) },
    { adopt: () => {} },
  ) as () => Promise<void>
  return { refresh, content, drawn }
}

test("a figure's line reports its last move and that move's age", () => {
  const p = page()
  p.noteRead(1_000, true)
  expect(p.movedText(p.trackMove("total", null, 1_000), 1_000)).toBe("")
  expect(p.movedText(p.trackMove("total", 312.03, 1_000), 1_000)).toBe("")
  expect(p.movedText(p.trackMove("total", 312.45, 3_000), 3_000)).toBe("+$0.42 · now")
  expect(p.movedText(p.trackMove("total", 312.45, 15_000), 15_000)).toBe("+$0.42 · 12s ago")
  expect(p.movedText(p.trackMove("total", 311.45, 200_000), 200_000)).toBe("−$1.00 · now")
  expect(p.movedText(p.trackMove("total", 311.45, 500_000), 500_000)).toBe("−$1.00 · 5m ago")
})

test("one account's move leaves another account's line alone", () => {
  const p = page()
  p.noteRead(1_000, true)
  p.trackMove("p:main", 10, 1_000)
  p.trackMove("p:backup", 5, 1_000)
  p.trackMove("p:main", 10.5, 3_000)
  expect(p.movedText(p.trackMove("p:backup", 5, 3_000), 3_000)).toBe("")
  expect(p.movedText(p.trackMove("p:main", 10.5, 5_000), 5_000)).toBe("+$0.50 · 2s ago")
})

test("a move on the first read after a minute without one is labelled as time away", () => {
  const p = page()
  p.noteRead(1_000, true)
  p.trackMove("total", 300, 1_000)
  p.noteRead(841_000, true)
  expect(p.movedText(p.trackMove("total", 306.18, 841_000), 841_000)).toBe("+$6.18 while away 14m")
  p.noteRead(843_000, true)
  expect(p.movedText(p.trackMove("total", 306.18, 843_000), 843_000)).toBe("+$6.18 while away 14m")
  p.noteRead(845_000, true)
  expect(p.movedText(p.trackMove("total", 306.6, 845_000), 845_000)).toBe("+$0.42 · now")
})

test("a move after a gap under a minute is an ordinary move", () => {
  const p = page()
  p.noteRead(1_000, true)
  p.trackMove("total", 300, 1_000)
  p.noteRead(60_000, true)
  expect(p.movedText(p.trackMove("total", 301, 60_000), 60_000)).toBe("+$1.00 · now")
})

test("only a figure that changed on this read is marked to flash", () => {
  const p = page()
  p.noteRead(1_000, true)
  expect(p.flashClass(p.trackMove("total", 10, 1_000))).toBe("")
  expect(p.flashClass(p.trackMove("total", 10.5, 3_000))).toBe(" flash-up")
  expect(p.flashClass(p.trackMove("total", 10.5, 5_000))).toBe("")
  expect(p.flashClass(p.trackMove("total", 9, 7_000))).toBe(" flash-down")
})

test("the clock counts from the last good read while reads fail", () => {
  const p = page()
  p.noteRead(1_000, true)
  expect(text(p.clockHtml(1_000))).toBe("live")
  p.noteRead(3_000, false)
  p.noteRead(9_000, false)
  expect(text(p.clockHtml(9_000))).toBe("no answer · last read 8s ago")
  p.noteRead(11_000, true)
  expect(text(p.clockHtml(11_000))).toBe("live")
})

test("time away is measured from the last good read, across failed ones", () => {
  const p = page()
  p.noteRead(1_000, true)
  p.trackMove("total", 300, 1_000)
  p.noteRead(30_000, false)
  p.noteRead(90_000, true)
  expect(p.movedText(p.trackMove("total", 303, 90_000), 90_000)).toBe("+$3.00 while away 1m")
})

test("a failed read redraws the figures the page already has", async () => {
  const f = pageRefresh(["health", "stats", "quota", "profiles"])
  await f.refresh()
  expect(f.drawn).toEqual([["health", "stats", "quota", "profiles"]])
  expect(f.content.innerHTML).toBe("the page as last drawn")
})

test("a failed first read says the page could not connect", async () => {
  const f = pageRefresh(null)
  await f.refresh()
  expect(f.drawn).toEqual([])
  expect(text(f.content.innerHTML)).toBe("Could not connect")
})

test("a calendar period's read keeps one key all day and a new one after midnight", () => {
  const p = page()
  const noon = new Date(2026, 10, 26, 12).getTime()
  const midnight = new Date(2026, 10, 26).getTime()
  expect(p.readPlan("today", noon)).toEqual({ key: "today" + midnight, url: "/telemetry/usage?since=" + midnight })
  expect(p.readPlan("today", noon + 2000).key).toBe("today" + midnight)
  expect(p.readPlan("today", midnight + 86400001).key).not.toBe("today" + midnight)
  expect(p.readPlan("24h", noon)).toEqual({ key: "24h", url: "/telemetry/usage?window=86400000" })
})

test("a new window forgets the last one's figures, so the jump is not a move", () => {
  const p = page()
  p.noteRead(1_000, true)
  p.enterWindow("a")
  p.trackMove("total", 5, 1_000)
  expect(p.flashClass(p.trackMove("total", 6, 3_000))).toBe(" flash-up")
  p.enterWindow("b")
  const jump = p.trackMove("total", 300, 5_000)
  expect(p.flashClass(jump)).toBe("")
  expect(p.movedText(jump, 5_000)).toBe("")
})

test("an answer overtaken by a newer one is not drawn", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let healthReads = 0
  const answer = (body: unknown) => ({ ok: true, json: async () => body })
  const f = pageRefresh(null, (url) => {
    if (url === "/health" && ++healthReads === 1) return held.then(() => answer({}))
    return Promise.resolve(answer({}))
  })
  const first = f.refresh()
  await f.refresh()
  expect(f.drawn.length).toBe(1)
  release()
  await first
  expect(f.drawn.length).toBe(1)
})
