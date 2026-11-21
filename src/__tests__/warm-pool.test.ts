import { describe, expect, it } from "bun:test"
import type { Options, WarmQuery } from "@anthropic-ai/claude-agent-sdk"
import { createWarmPool, differingParts, warmShape, type WarmPoolDeps } from "../proxy/warmPool"
import type { SdkProcessGate } from "../proxy/session/sdkProcessGate"

const baseOptions = (extra: Partial<Options> = {}): Options => ({
  model: "claude-haiku-5-5",
  maxTurns: 1,
  cwd: "/tmp",
  tools: [],
  systemPrompt: "be brief",
  env: { A: "1", TOKEN: "secret" },
  ...extra,
})

interface Started {
  options: Options
  closed: boolean
  prompts: unknown[]
  exit: () => void
}

function harness(config: Partial<{ maxIdle: number; idleMs: number; reserveMs: number }> = {}) {
  const started: Started[] = []
  const joined: number[] = []
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  let gates = 0
  const deps: WarmPoolDeps = {
    createGate: async () => {
      const id = gates++
      const listeners: Array<() => void> = []
      const gate = {
        executor: { pid: id } as unknown as SdkProcessGate["executor"],
        recoverableAfterCrash: true,
        spawnClaudeCodeProcess: () => ({
          once: (_: string, listener: () => void) => { listeners.push(listener) },
        }) as unknown as ReturnType<SdkProcessGate["spawnClaudeCodeProcess"]>,
        closeAndJoin: async () => { joined.push(id); return true },
      } satisfies SdkProcessGate
      ;(gate as unknown as { fireExit: () => void }).fireExit = () => listeners.forEach((listener) => listener())
      return gate
    },
    startup: async ({ options }) => {
      const child = options.spawnClaudeCodeProcess!({} as never) as unknown as { once: unknown }
      void child
      const record: Started = { options, closed: false, prompts: [], exit: () => {} }
      started.push(record)
      return {
        query: (prompt: unknown) => { record.prompts.push(prompt); return { prompt } as never },
        close: () => { record.closed = true },
        [Symbol.asyncDispose]: async () => {},
      } as unknown as WarmQuery
    },
    log: (event, fields) => { events.push({ event, fields }) },
  }
  const pool = createWarmPool({ maxIdle: 2, idleMs: 60_000, reserveMs: 60_000, ...config }, deps)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
  return { pool, started, joined, events, settle }
}

describe("warmShape", () => {
  it("ignores the per-request fields", () => {
    const a = warmShape(baseOptions({ sessionId: "a", abortController: new AbortController(), stderr: () => {} }))
    const b = warmShape(baseOptions({ sessionId: "b" }))
    expect(a?.fingerprint).toBeDefined()
    expect(a?.fingerprint).toBe(b?.fingerprint as string)
  })

  it("does not depend on key order", () => {
    const a = warmShape({ model: "m", cwd: "/x", env: { A: "1", B: "2" } })
    const b = warmShape({ env: { B: "2", A: "1" }, cwd: "/x", model: "m" })
    expect(a?.fingerprint).toBe(b?.fingerprint as string)
  })

  it("separates turns that would start a different subprocess", () => {
    const base = warmShape(baseOptions())!.fingerprint
    expect(warmShape(baseOptions({ model: "claude-opus-5-5" }))!.fingerprint).not.toBe(base)
    expect(warmShape(baseOptions({ systemPrompt: "other" }))!.fingerprint).not.toBe(base)
    expect(warmShape(baseOptions({ env: { A: "1", TOKEN: "rotated" } }))!.fingerprint).not.toBe(base)
    expect(warmShape(baseOptions({ hooks: { PreToolUse: [{ matcher: "", hooks: [async () => ({})] }] } }))!.fingerprint)
      .not.toBe(base)
  })

  it("treats hooks with the same layout as the same shape", () => {
    const a = warmShape(baseOptions({ hooks: { PreToolUse: [{ matcher: "", hooks: [async () => ({})] }] } }))
    const b = warmShape(baseOptions({ hooks: { PreToolUse: [{ matcher: "", hooks: [async () => ({ x: 1 } as never)] }] } }))
    expect(a?.fingerprint).toBe(b?.fingerprint as string)
  })

  it("refuses turns bound to an existing session or to live objects", () => {
    expect(warmShape(baseOptions({ resume: "s" }))).toBeUndefined()
    expect(warmShape(baseOptions({ forkSession: true }))).toBeUndefined()
    expect(warmShape(baseOptions({ persistSession: false }))).toBeUndefined()
    expect(warmShape(baseOptions({ mcpServers: { x: { command: "y" } as never } }))).toBeUndefined()
    expect(warmShape(baseOptions({ canUseTool: (async () => ({})) as never }))).toBeUndefined()
    expect(warmShape(baseOptions({ mcpServers: {} }))).toBeDefined()
  })

  it("ignores env the SDK writes after its first query", () => {
    const a = warmShape(baseOptions())
    const b = warmShape(baseOptions({ env: { A: "1", TOKEN: "secret", CLAUDE_AGENT_SDK_VERSION: "0.2.141" } }))
    expect(a?.fingerprint).toBe(b?.fingerprint as string)
  })

  it("names what differs without exposing values", () => {
    const a = warmShape(baseOptions())!
    const b = warmShape(baseOptions({ model: "other", env: { A: "1", TOKEN: "rotated" } }))!
    expect(differingParts(a.parts, b.parts)).toEqual(["env.TOKEN", "model"])
    expect(JSON.stringify(a.parts)).not.toContain("secret")
  })
})

describe("createWarmPool", () => {
  it("serves the next identical turn from the process started for it", async () => {
    const { pool, started, settle } = harness()
    expect(pool.reserve("h")).toBeUndefined()
    pool.refill("h", baseOptions({ sessionId: "request-1" }))
    await settle()
    expect(pool.stats().idle).toBe(1)
    const sessionId = pool.reserve("h")
    expect(sessionId).toBe(started[0]!.options.sessionId as string)
    expect(sessionId).not.toBe("request-1")
    const stderr: string[] = []
    const claim = await pool.claim(sessionId, new AbortController().signal, baseOptions({ sessionId, stderr: (line) => stderr.push(line) }))
    expect(claim?.sessionId).toBe(sessionId as string)
    claim!.query("hello")
    expect(started[0]!.prompts).toEqual(["hello"])
    started[0]!.options.stderr!("oops")
    expect(stderr).toEqual(["oops"])
    expect(pool.stats()).toMatchObject({ idle: 0, reserved: 0, hits: 1 })
  })

  it("closes and joins a process whose options differ before the id is reused", async () => {
    const { pool, started, joined, events, settle } = harness()
    pool.refill("h", baseOptions())
    await settle()
    const sessionId = pool.reserve("h")
    const claim = await pool.claim(sessionId, new AbortController().signal, baseOptions({ sessionId, systemPrompt: "changed" }))
    expect(claim).toBeUndefined()
    expect(started[0]!.closed).toBe(true)
    expect(joined).toEqual([0])
    expect(events.find((entry) => entry.event === "warm_pool.mismatch")?.fields.differing).toEqual(["systemPrompt"])
    expect(pool.stats()).toMatchObject({ mismatches: 1, misses: 1, reserved: 0 })
  })

  it("forwards hooks to the claiming request", async () => {
    const { pool, started, settle } = harness()
    const hooksFor = (tag: string): Options["hooks"] => ({
      PreToolUse: [{ matcher: "", hooks: [async () => ({ tag }) as never] }],
    })
    pool.refill("h", baseOptions({ hooks: hooksFor("first") }))
    await settle()
    const sessionId = pool.reserve("h")
    const warmHook = started[0]!.options.hooks!.PreToolUse![0]!.hooks[0]! as unknown as () => Promise<unknown>
    expect(await warmHook()).toEqual({})
    await pool.claim(sessionId, new AbortController().signal, baseOptions({ sessionId, hooks: hooksFor("second") }))
    expect(await warmHook()).toEqual({ tag: "second" })
  })

  it("keeps one process per shape and replaces the oldest at capacity", async () => {
    const { pool, started, settle } = harness({ maxIdle: 2 })
    pool.refill("h", baseOptions())
    pool.refill("h", baseOptions())
    await settle()
    expect(started.length).toBe(1)
    pool.refill("h", baseOptions({ systemPrompt: "two" }))
    await settle()
    pool.refill("h", baseOptions({ systemPrompt: "three" }))
    await settle()
    expect(started.length).toBe(3)
    expect(started[0]!.closed).toBe(true)
    expect(pool.stats().idle).toBe(2)
  })

  it("does not start anything for an ineligible turn", async () => {
    const { pool, started, settle } = harness()
    pool.refill("h", baseOptions({ resume: "s" }))
    await settle()
    expect(started.length).toBe(0)
  })

  it("expires idle and unclaimed processes", async () => {
    const { pool, started, joined } = harness({ idleMs: 10, reserveMs: 10 })
    pool.refill("h", baseOptions())
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(started[0]!.closed).toBe(true)
    expect(pool.reserve("h")).toBeUndefined()
    pool.refill("h", baseOptions())
    await new Promise((resolve) => setTimeout(resolve, 3))
    expect(pool.reserve("h")).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(started[1]!.closed).toBe(true)
    expect(joined.length).toBe(2)
    expect(pool.stats()).toMatchObject({ idle: 0, reserved: 0, expired: 1 })
  })

  it("starts a process for each hint even when the shape is shared", async () => {
    const { pool, started, settle } = harness()
    pool.refill("a", baseOptions())
    pool.refill("b", baseOptions())
    await settle()
    expect(started.length).toBe(2)
    expect(pool.reserve("b")).toBeDefined()
  })

  it("only hands out processes reserved under the same hint", async () => {
    const { pool, settle } = harness()
    pool.refill("a", baseOptions())
    await settle()
    expect(pool.reserve("b")).toBeUndefined()
    expect(pool.reserve("a")).toBeDefined()
    expect(pool.reserve("a")).toBeUndefined()
  })

  it("closes everything on stop and starts nothing afterwards", async () => {
    const { pool, started, settle } = harness()
    pool.refill("h", baseOptions())
    await settle()
    await pool.stop()
    expect(started[0]!.closed).toBe(true)
    pool.refill("h", baseOptions())
    await settle()
    expect(started.length).toBe(1)
    expect(pool.reserve("h")).toBeUndefined()
  })
})
