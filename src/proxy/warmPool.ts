/**
 * Warm pool: pre-started Claude Code subprocesses for fresh, tool-less turns.
 *
 * A cold turn pays the CLI's start and initialize handshake (about 0.8 s on
 * the cycorn host) before the request reaches Anthropic. The Agent SDK's
 * `startup()` runs that part ahead of time and hands back a process that only
 * waits for its prompt. Everything a subprocess is started with is fixed at
 * spawn, though, including its session id, so a warm process can serve a
 * request only when that request would have started an identical one.
 *
 * The pool therefore works by prediction: after an eligible turn it starts a
 * replacement with the same options and a session id of its own. A later
 * fresh turn reserves that id before it prepares its transcript, and the
 * launch site claims the process only if the options the request actually
 * built match the ones the process was started with. On any mismatch the warm
 * process is closed and the request starts cold under the same session id,
 * which is safe because an idle process has written nothing.
 *
 * Off unless MERIDIAN_WARM_POOL=1.
 */

import { createHash, randomUUID } from "node:crypto"
import type { Options, Query, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk"
import type { SdkProcessGate } from "./session/sdkProcessGate"

type HookTable = NonNullable<Options["hooks"]>
type HookFn = (...args: unknown[]) => unknown

/** Fields that belong to one request and are rebound when a process is claimed. */
const PER_REQUEST_FIELDS = new Set(["abortController", "stderr", "spawnClaudeCodeProcess", "sessionId", "hooks"])

/**
 * Fields that tie a subprocess to an existing session or to live objects of
 * one request. A request carrying any of them is never served warm.
 */
const INELIGIBLE_FIELDS = ["resume", "resumeSessionAt", "forkSession", "continue", "canUseTool", "agents"] as const

function stableStringify(value: unknown): string | undefined {
  if (typeof value === "function" || typeof value === "symbol") return undefined
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      const part = stableStringify(item)
      if (part === undefined) return undefined
      parts.push(part)
    }
    return `[${parts.join(",")}]`
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return undefined
  const parts: string[] = []
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) continue
    const part = stableStringify(item)
    if (part === undefined) return undefined
    parts.push(`${JSON.stringify(key)}:${part}`)
  }
  return `{${parts.join(",")}}`
}

/** Events, matchers and callback counts of a hook table, without the callbacks. */
function hookLayout(hooks: Options["hooks"]): string | undefined {
  if (!hooks) return "{}"
  const layout: Record<string, unknown> = {}
  for (const event of Object.keys(hooks).sort()) {
    const matchers = (hooks as Record<string, unknown>)[event]
    if (matchers === undefined) continue
    if (!Array.isArray(matchers)) return undefined
    const entries: unknown[] = []
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== "object") return undefined
      const { hooks: callbacks, ...rest } = matcher as { hooks?: unknown } & Record<string, unknown>
      if (!Array.isArray(callbacks) || callbacks.some((callback) => typeof callback !== "function")) return undefined
      entries.push({ ...rest, callbacks: callbacks.length })
    }
    layout[event] = entries
  }
  return stableStringify(layout)
}

export interface WarmShape {
  /** Hash of every option the subprocess is started with, hooks by layout only. */
  readonly fingerprint: string
  /** One hash per option (and per env variable), to name what differed on a mismatch. */
  readonly parts: Readonly<Record<string, string>>
  /** The options to start a replacement with, minus the per-request fields. */
  readonly template: Options
  readonly hooks: Options["hooks"]
}

/**
 * The part of a request's options a warm process must share, or undefined
 * when the request cannot be served warm at all.
 */
export function warmShape(options: Options | undefined): WarmShape | undefined {
  if (!options) return undefined
  const record = options as Record<string, unknown>
  for (const field of INELIGIBLE_FIELDS) {
    if (record[field] !== undefined && record[field] !== false) return undefined
  }
  if (record.persistSession === false) return undefined
  const mcpServers = record.mcpServers
  if (mcpServers !== undefined && (typeof mcpServers !== "object" || mcpServers === null || Object.keys(mcpServers).length > 0)) {
    return undefined
  }
  const template: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (PER_REQUEST_FIELDS.has(key) || value === undefined) continue
    if (key === "mcpServers") continue
    template[key] = value
  }
  const body = stableStringify(template)
  const layout = hookLayout(options.hooks)
  if (body === undefined || layout === undefined) return undefined
  const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16)
  const parts: Record<string, string> = { hooks: digest(layout) }
  for (const [key, value] of Object.entries(template)) {
    if (key === "env" && value && typeof value === "object") {
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
        if (item !== undefined) parts[`env.${name}`] = digest(String(item))
      }
    } else {
      parts[key] = digest(stableStringify(value) ?? "")
    }
  }
  return {
    fingerprint: createHash("sha256").update(body).update("\0").update(layout).digest("hex"),
    parts,
    template: template as Options,
    hooks: options.hooks,
  }
}

/** Names of the options two shapes disagree on. Values never leave the process. */
export function differingParts(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>> | undefined): string[] {
  if (!b) return ["(not eligible)"]
  const names = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...names].filter((name) => a[name] !== b[name]).sort()
}

/**
 * A hook table with the layout of `hooks` whose callbacks forward to whatever
 * table is bound later. An unbound callback answers with no decision, which
 * is what a turn with no hook would get.
 */
function forwardingHooks(hooks: Options["hooks"]): { table: Options["hooks"]; bind: (target: Options["hooks"]) => void } {
  if (!hooks) return { table: undefined, bind: () => {} }
  let target: Options["hooks"]
  const table: Record<string, unknown> = {}
  for (const event of Object.keys(hooks)) {
    const matchers = (hooks as Record<string, Array<{ hooks: HookFn[] } & Record<string, unknown>> | undefined>)[event]
    if (!matchers) continue
    table[event] = matchers.map((matcher, matcherIndex) => ({
      ...matcher,
      hooks: matcher.hooks.map((_, callbackIndex): HookFn => (...args) => {
        const bound = (target as Record<string, Array<{ hooks: HookFn[] }> | undefined> | undefined)
          ?.[event]?.[matcherIndex]?.hooks[callbackIndex]
        return bound ? bound(...args) : Promise.resolve({})
      }),
    }))
  }
  return { table: table as HookTable, bind: (next) => { target = next } }
}

type EntryState = "warming" | "idle" | "reserved" | "claimed" | "closed"

interface Entry {
  readonly sessionId: string
  readonly hint: string
  readonly fingerprint: string
  readonly parts: Readonly<Record<string, string>>
  readonly abortController: AbortController
  state: EntryState
  gate?: SdkProcessGate
  warm?: WarmQuery
  exited: boolean
  readyAt?: number
  timer?: ReturnType<typeof setTimeout>
  stderr?: (data: string) => void
  bindHooks: (target: Options["hooks"]) => void
}

/** What the launch site gets for a claimed process. */
export interface WarmClaim {
  readonly sessionId: string
  /** Already holds the running subprocess; the caller attaches its lease and joins it. */
  readonly gate: SdkProcessGate
  /** How long the process sat ready before it was claimed. */
  readonly idleMs: number
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query
}

export interface WarmPoolDeps {
  startup: (params: { options: Options }) => Promise<WarmQuery>
  /** A process gate whose executor is attached to a transcript lease later, at claim. */
  createGate: (onStderr: (data: string) => void) => Promise<SdkProcessGate>
  log?: (event: string, fields: Record<string, unknown>) => void
  now?: () => number
}

export interface WarmPoolConfig {
  /** Most processes kept warming or idle at once. */
  maxIdle: number
  /** An idle process older than this is closed. */
  idleMs: number
  /** A reserved process not claimed within this is closed. */
  reserveMs: number
}

export interface WarmPoolStats {
  warming: number
  idle: number
  reserved: number
  hits: number
  misses: number
  mismatches: number
  expired: number
  failed: number
}

export interface WarmPool {
  /** Take the newest idle process for `hint` out of the pool and return its session id. */
  reserve(hint: string): string | undefined
  /**
   * The reserved process for `sessionId`, if `options` are the ones it was
   * started with. A mismatch closes the process and returns undefined only
   * once it is gone, so a cold start may reuse the session id.
   */
  claim(sessionId: string | undefined, signal: AbortSignal, options: Options | undefined): Promise<WarmClaim | undefined>
  /** Start a replacement for a turn that just ran with `options`, capacity allowing. */
  refill(hint: string, options: Options | undefined): void
  stop(): Promise<void>
  stats(): WarmPoolStats
}

export function createWarmPool(config: WarmPoolConfig, deps: WarmPoolDeps): WarmPool {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const entries = new Map<string, Entry>()
  const closing = new Set<Promise<void>>()
  const counters = { hits: 0, misses: 0, mismatches: 0, expired: 0, failed: 0 }
  let stopped = false

  const count = (...states: EntryState[]): number => {
    let total = 0
    for (const entry of entries.values()) if (states.includes(entry.state)) total += 1
    return total
  }

  const close = (entry: Entry, reason: string): Promise<void> => {
    if (entry.state === "closed") return Promise.resolve()
    const previous = entry.state
    entry.state = "closed"
    if (entry.timer) clearTimeout(entry.timer)
    entries.delete(entry.sessionId)
    const done = (async () => {
      try {
        entry.abortController.abort(new Error(`warm process closed: ${reason}`))
        entry.warm?.close()
      } catch { /* the join below is what matters */ }
      try {
        await entry.gate?.closeAndJoin()
      } catch (error) {
        log("warm_pool.close_failed", { sessionId: entry.sessionId, error: String(error) })
      }
      log("warm_pool.closed", { sessionId: entry.sessionId, reason, from: previous })
    })()
    closing.add(done)
    void done.finally(() => closing.delete(done))
    return done
  }

  const arm = (entry: Entry, ms: number, reason: string, counter?: "expired"): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (counter) counters[counter] += 1
      void close(entry, reason)
    }, ms)
    entry.timer.unref?.()
  }

  // Read through a function: the state changes across awaits, which the
  // compiler's narrowing of a property does not model.
  const closedWhileStarting = (entry: Entry): boolean => entry.state === "closed"

  const start = async (hint: string, shape: WarmShape): Promise<void> => {
    const forwarding = forwardingHooks(shape.hooks)
    const entry: Entry = {
      sessionId: randomUUID(),
      hint,
      fingerprint: shape.fingerprint,
      parts: shape.parts,
      abortController: new AbortController(),
      state: "warming",
      exited: false,
      bindHooks: forwarding.bind,
    }
    entries.set(entry.sessionId, entry)
    const startedAt = now()
    const onStderr = (data: string): void => { entry.stderr?.(data) }
    try {
      const gate = await deps.createGate(onStderr)
      entry.gate = gate
      if (closedWhileStarting(entry)) {
        await gate.closeAndJoin().catch(() => {})
        return
      }
      const warm = await deps.startup({
        options: {
          ...shape.template,
          sessionId: entry.sessionId,
          abortController: entry.abortController,
          stderr: onStderr,
          ...(forwarding.table ? { hooks: forwarding.table } : {}),
          spawnClaudeCodeProcess: (spawnOptions) => {
            const child = gate.spawnClaudeCodeProcess(spawnOptions)
            child.once("exit", () => {
              entry.exited = true
              if (entry.state === "idle" || entry.state === "reserved") void close(entry, "process exited")
            })
            return child
          },
        },
      })
      entry.warm = warm
      if (closedWhileStarting(entry)) {
        // close() ran before the handle existed, so it could not close it.
        try { warm.close() } catch { /* joined below */ }
        await gate.closeAndJoin().catch(() => {})
        return
      }
      if (entry.exited) {
        await close(entry, "process exited during startup")
        return
      }
      entry.state = "idle"
      entry.readyAt = now()
      arm(entry, config.idleMs, "idle timeout", "expired")
      log("warm_pool.ready", { sessionId: entry.sessionId, startupMs: entry.readyAt - startedAt })
    } catch (error) {
      counters.failed += 1
      log("warm_pool.start_failed", { sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) })
      await close(entry, "startup failed")
    }
  }

  return {
    reserve(hint) {
      if (stopped) return undefined
      let newest: Entry | undefined
      for (const entry of entries.values()) {
        if (entry.state !== "idle" || entry.hint !== hint || entry.exited) continue
        if (!newest || (entry.readyAt ?? 0) > (newest.readyAt ?? 0)) newest = entry
      }
      if (!newest) return undefined
      newest.state = "reserved"
      arm(newest, config.reserveMs, "reservation not claimed")
      return newest.sessionId
    },

    async claim(sessionId, signal, options) {
      const entry = sessionId ? entries.get(sessionId) : undefined
      if (!entry || entry.state !== "reserved") return undefined
      const shape = warmShape(options)
      const usable = !stopped && !signal.aborted && !entry.exited && entry.warm && entry.gate
        && shape?.fingerprint === entry.fingerprint
      if (!usable) {
        if (shape?.fingerprint !== entry.fingerprint) {
          counters.mismatches += 1
          log("warm_pool.mismatch", { sessionId: entry.sessionId, differing: differingParts(entry.parts, shape?.parts) })
        }
        counters.misses += 1
        // Joined before returning: a cold start is about to reuse this id.
        await close(entry, "options differ from the warm process")
        return undefined
      }
      if (entry.timer) clearTimeout(entry.timer)
      entry.state = "claimed"
      entries.delete(entry.sessionId)
      entry.stderr = options?.stderr
      entry.bindHooks(options?.hooks)
      const abort = (): void => entry.abortController.abort(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      counters.hits += 1
      const warm = entry.warm!
      return {
        sessionId: entry.sessionId,
        gate: entry.gate!,
        idleMs: now() - (entry.readyAt ?? now()),
        query: (prompt) => warm.query(prompt),
      }
    },

    refill(hint, options) {
      if (stopped) return
      const shape = warmShape(options)
      if (!shape) return
      for (const entry of entries.values()) {
        // One process per distinct turn shape is enough to serve the next one.
        if (entry.fingerprint === shape.fingerprint && (entry.state === "idle" || entry.state === "warming")) return
      }
      if (count("idle", "warming") >= config.maxIdle) {
        // Make room for the shape that is in use now.
        let oldest: Entry | undefined
        for (const entry of entries.values()) {
          if (entry.state !== "idle") continue
          if (!oldest || (entry.readyAt ?? 0) < (oldest.readyAt ?? 0)) oldest = entry
        }
        if (!oldest) return
        void close(oldest, "replaced by a newer shape")
      }
      void start(hint, shape)
    },

    async stop() {
      stopped = true
      for (const entry of [...entries.values()]) void close(entry, "pool stopped")
      await Promise.allSettled([...closing])
    },

    stats() {
      return {
        warming: count("warming"),
        idle: count("idle"),
        reserved: count("reserved"),
        ...counters,
      }
    },
  }
}
