/**
 * usageSince keeps running totals; computeSummary over the same rows is the
 * reference. Both stores must give the landing page the same figures.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MemoryTelemetryStore } from "../telemetry/store"
import { createSqliteStores } from "../telemetry/sqlite"
import { computeSummary } from "../telemetry/percentiles"
import { getPricingOverrides, resetPricingOverridesCache, setPricingOverride } from "../telemetry/pricingStore"
import type { ITelemetryStore, RequestMetric, UsageSummary } from "../telemetry/types"

const DAY = 86_400_000
let seq = 0

function metric(timestamp: number, overrides: Partial<RequestMetric> = {}): RequestMetric {
  seq++
  return {
    requestId: `req-${seq}`, timestamp, model: "sonnet", mode: "stream", isResume: false, isPassthrough: false,
    status: 200, queueWaitMs: 5, proxyOverheadMs: 12, ttfbMs: 120, upstreamDurationMs: 800,
    totalDurationMs: 100 + (seq % 17) * 37, contentBlocks: 3, textEvents: 10, error: null,
    inputTokens: 1_200, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 2_000,
    cacheHitRate: 0.25, profileId: "main",
    ...overrides,
  }
}

/** One row per pricing branch and per way a row can be counted. */
function everyKind(at: number): RequestMetric[] {
  return [
    metric(at, { model: "claude-fable-5-2" }),
    metric(at, { model: "opus", resolvedModel: "claude-opus-4-5", profileId: "backup" }),
    metric(at, { model: "claude-haiku-5-5", cacheReadInputTokens: 150_000, cacheHitRate: 0.98 }),
    metric(at, { model: "claude-haiku-5-5", cacheReadInputTokens: 60_000, profileId: "backup" }),
    metric(at, { model: "gpt-5.5", requestModel: "gpt-5.5-high", cacheReadInputTokens: 300_000, cacheHitRate: 0.99 }),
    metric(at, { model: "gpt-5.5", requestModel: "gpt-5.5-high", cacheReadInputTokens: 60_000 }),
    metric(at, { model: "mystery-model-9" }),
    metric(at, { requestSource: "cache-keepalive", cacheReadInputTokens: 40_000, cacheHitRate: 1 }),
    metric(at, { profileId: undefined }),
    metric(at, { error: "upstream refused", status: 500 }),
    metric(at, { envelopeViolations: ["dangling tool_use", "empty input"] }),
    metric(at, { cacheHitRate: undefined }),
  ]
}

const pick = (s: UsageSummary) => ({
  totalRequests: s.totalRequests,
  errorCount: s.errorCount,
  envelopeViolationCount: s.envelopeViolationCount,
  tokenUsage: {
    totalInputTokens: s.tokenUsage.totalInputTokens,
    totalOutputTokens: s.tokenUsage.totalOutputTokens,
    avgCacheHitRate: s.tokenUsage.avgCacheHitRate,
  },
  totalDuration: { p50: s.totalDuration.p50, p95: s.totalDuration.p95 },
})

function expectParity(store: ITelemetryStore, since: number, slideKey?: string): UsageSummary {
  const want = computeSummary(store.getRecent({ limit: 100_000, since }), 0, getPricingOverrides())
  const got = store.usageSince(since, slideKey)
  expect(pick(got)).toEqual(pick(want))
  const profiles = Object.keys(want.costEstimate.byProfile).sort()
  expect(Object.keys(got.costEstimate.byProfile).sort()).toEqual(profiles)
  // The summary's own rounding step; one row on a wrong tier is off by cents.
  expect(Math.abs(got.costEstimate.totalUsd - want.costEstimate.totalUsd)).toBeLessThanOrEqual(1e-6)
  for (const id of profiles) {
    expect(got.costEstimate.byProfile[id]!.requests).toBe(want.costEstimate.byProfile[id]!.requests)
    expect(Math.abs(got.costEstimate.byProfile[id]!.estimatedUsd - want.costEstimate.byProfile[id]!.estimatedUsd)).toBeLessThanOrEqual(1e-6)
  }
  return got
}

const recordAll = (store: ITelemetryStore, rows: RequestMetric[]) => { for (const row of rows) store.record(row) }

function usageContract(name: string, open: () => ITelemetryStore) {
  describe(`${name} usageSince`, () => {
    let dir: string
    const savedConfig = process.env.MERIDIAN_PRICING_CONFIG
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "meridian-usage-totals-"))
      process.env.MERIDIAN_PRICING_CONFIG = join(dir, "model-pricing.json")
      resetPricingOverridesCache()
    })
    afterEach(() => {
      if (savedConfig === undefined) delete process.env.MERIDIAN_PRICING_CONFIG
      else process.env.MERIDIAN_PRICING_CONFIG = savedConfig
      resetPricingOverridesCache()
      rmSync(dir, { recursive: true, force: true })
    })

    it("matches the summary on the first read of a period", () => {
      const store = open()
      const since = Date.now() - 60_000
      recordAll(store, everyKind(since))
      const got = expectParity(store, since)
      expect(got.totalRequests).toBe(11)
      expect(got.costEstimate.totalUsd).toBeGreaterThan(0)
    })

    it("adds later rows, skips one stamped before the window, and starts over after a clear", () => {
      const store = open()
      const since = Date.now() - 60_000
      recordAll(store, everyKind(since))
      expectParity(store, since)
      recordAll(store, everyKind(since + 1_000))
      expectParity(store, since)
      store.record(metric(since - 1, { model: "claude-haiku-5-5", cacheReadInputTokens: 150_000 }))
      expectParity(store, since)
      store.clear()
      expectParity(store, since)
      recordAll(store, everyKind(since + 2_000))
      expectParity(store, since)
    })

    it("subtracts what a rolling window slides past, a profile's last request included", () => {
      const store = open()
      const t0 = Date.now() - 60_000
      recordAll(store, everyKind(t0))
      store.record(metric(t0, { profileId: "solo", model: "claude-haiku-5-5", cacheReadInputTokens: 150_000 }))
      expect(expectParity(store, t0, "w").costEstimate.byProfile.solo).toBeDefined()
      recordAll(store, everyKind(t0 + 5_000))
      const got = expectParity(store, t0 + 1, "w")
      expect(got.costEstimate.byProfile.solo).toBeUndefined()
      expect(got.totalRequests).toBe(11)
    })

    it("reprices every window after a price override changes", () => {
      const store = open()
      const since = Date.now() - 60_000
      recordAll(store, everyKind(since))
      const before = expectParity(store, since)
      setPricingOverride("claude-fable-5-2", { inputPerMTok: 500, outputPerMTok: 2_500, cacheReadPerMTok: 50, cacheWritePerMTok: 625 })
      const after = expectParity(store, since)
      expect(after.costEstimate.totalUsd).toBeGreaterThan(before.costEstimate.totalUsd)
    })

    it("forgets rows that retention deletes", () => {
      const store = open()
      const now = Date.now()
      const old = [0, 1, 2].map(() => metric(now - 10 * DAY, { model: "claude-haiku-5-5", cacheReadInputTokens: 150_000 }))
      recordAll(store, old)
      expectParity(store, now - 30 * DAY)
      // The sqlite store runs cleanup() on its 1000th insert.
      for (let i = old.length; i < 1000; i++) store.record(metric(now - 1_000))
      expect(store.getRecent({ limit: 2000, since: now - 30 * DAY }).length).toBe(store.describe().kind === "sqlite" ? 997 : 1000)
      expectParity(store, now - 30 * DAY)
    })
  })
}

usageContract("MemoryTelemetryStore", () => new MemoryTelemetryStore(2000))
usageContract("SqliteTelemetryStore", () => createSqliteStores(":memory:", 7).telemetry)
