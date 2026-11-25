import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"

test("the cost detail line reports the figure's last move and its age", () => {
  const line = (name: string) => landingHtml.match(new RegExp(`^(?:function|var) ${name}.*$`, "m"))![0]
  const page: Record<string, unknown> = {}
  runInNewContext(`${line("usd")}\n${line("costSeen")}\n${line("costMoved")}`, page)
  const costMoved = page.costMoved as (v: number | null, now: number) => string

  expect(costMoved(312.03, 1_000)).toBe("list prices")
  expect(costMoved(312.45, 3_000)).toBe("+$0.42 · 0s ago")
  expect(costMoved(312.45, 15_000)).toBe("+$0.42 · 12s ago")
  expect(costMoved(311.45, 200_000)).toBe("−$1.00 · 0s ago")
  expect(costMoved(311.45, 500_000)).toBe("−$1.00 · 5m ago")
})
