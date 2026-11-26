/**
 * Running totals behind GET /telemetry/usage, the landing page's read.
 *
 * A request is added once when it enters a window and subtracted once when a
 * rolling window leaves it behind, so a poll costs only the rows that moved.
 * Each request is priced on its own, with the same two calls
 * computeCostEstimate makes, because a prompt-size tier reprices a whole
 * request and no per-group sum could reproduce that. The result matches
 * computeSummary on every field it carries (usage-totals.test.ts).
 */

import { estimateRequestCostUsd, resolveRequestPricing, roundUsd, type ModelPricing } from "./pricing"
import type { RequestMetric, UsageSummary } from "./types"

export type UsageRow = Pick<RequestMetric,
  | "model" | "requestModel" | "resolvedModel" | "profileId"
  | "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens"
  | "cacheHitRate" | "totalDurationMs"> & { failed: boolean; envelopeViolations: number }

export interface UsageTotals {
  requests: number
  errors: number
  envelopeViolations: number
  inputTokens: number
  outputTokens: number
  hitRateSum: number
  hitRateCount: number
  totalUsd: number
  byProfile: Record<string, { requests: number; estimatedUsd: number }>
  durations: number[]
  sorted: boolean
}

export function emptyUsageTotals(): UsageTotals {
  return {
    requests: 0, errors: 0, envelopeViolations: 0, inputTokens: 0, outputTokens: 0,
    hitRateSum: 0, hitRateCount: 0, totalUsd: 0, byProfile: {}, durations: [], sorted: true,
  }
}

/** Add (`sign` 1) or take away (`sign` -1) one request. An unpriced one counts but adds no dollars. */
export function addUsage(totals: UsageTotals, row: UsageRow, sign: 1 | -1, overrides?: Record<string, ModelPricing>): void {
  totals.requests += sign
  if (row.failed) totals.errors += sign
  totals.envelopeViolations += sign * row.envelopeViolations
  totals.inputTokens += sign * (row.inputTokens ?? 0)
  totals.outputTokens += sign * (row.outputTokens ?? 0)
  if (row.cacheHitRate !== undefined) {
    totals.hitRateSum += sign * row.cacheHitRate
    totals.hitRateCount += sign
  }
  const id = row.profileId ?? "default"
  const profile = totals.byProfile[id] ??= { requests: 0, estimatedUsd: 0 }
  profile.requests += sign
  const pricing = resolveRequestPricing(row, overrides)
  const cost = pricing === null ? 0 : sign * estimateRequestCostUsd(row, pricing)
  totals.totalUsd += cost
  profile.estimatedUsd += cost
  if (profile.requests === 0) delete totals.byProfile[id]
  if (sign === 1) {
    totals.durations.push(row.totalDurationMs)
    totals.sorted = false
  } else {
    const at = totals.durations.indexOf(row.totalDurationMs)
    if (at >= 0) totals.durations.splice(at, 1)
  }
}

export function usageSummary(totals: UsageTotals): UsageSummary {
  if (!totals.sorted) {
    totals.durations.sort((a, b) => a - b)
    totals.sorted = true
  }
  const d = totals.durations
  const byProfile: UsageSummary["costEstimate"]["byProfile"] = {}
  for (const [id, entry] of Object.entries(totals.byProfile)) {
    byProfile[id] = { requests: entry.requests, estimatedUsd: roundUsd(entry.estimatedUsd) }
  }
  return {
    totalRequests: totals.requests,
    errorCount: totals.errors,
    envelopeViolationCount: totals.envelopeViolations,
    tokenUsage: {
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      avgCacheHitRate: totals.hitRateCount > 0 ? Math.round((totals.hitRateSum / totals.hitRateCount) * 100) / 100 : 0,
    },
    totalDuration: { p50: d[Math.floor(d.length * 0.5)] ?? 0, p95: d[Math.floor(d.length * 0.95)] ?? 0 },
    costEstimate: { totalUsd: roundUsd(totals.totalUsd), byProfile },
  }
}
