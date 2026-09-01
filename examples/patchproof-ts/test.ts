import assert from "node:assert/strict"
import test from "node:test"

import {
  formatMarkdown,
  parseContract,
  readConfig,
  resolveField,
  type ProofReport,
} from "./index.js"

const base = "1".repeat(40)
const head = "2".repeat(40)

test("parses an immutable base/head proof run", () => {
  const config = readConfig([
    "--repo",
    "https://github.com/example/app.git",
    "--base",
    base,
    "--head",
    head,
  ])

  if (config === "help") assert.fail("expected a parsed config")
  assert.equal(config.base, base)
  assert.equal(config.head, head)
  assert.equal(config.timeoutMs, 120_000)
})

test("rejects moving refs and credential-bearing repositories", () => {
  assert.throws(
    () =>
      readConfig([
        "--repo",
        "https://token@github.com/example/private.git",
        "--base",
        "main",
        "--head",
        head,
      ]),
    /without credentials/,
  )

  assert.throws(
    () =>
      readConfig([
        "--repo",
        "https://github.com/example/app.git",
        "--base",
        "main",
        "--head",
        head,
      ]),
    /40-character commit/,
  )
})

test("requires an oracle state change", () => {
  assert.throws(
    () =>
      parseContract({
        version: 1,
        workdir: "app",
        setup: "true",
        start: "node server.mjs",
        port: 3000,
        journey: {
          name: "change state",
          path: "/",
          click: { role: "button", name: "Approve" },
          expectText: "Approved",
          oracle: { path: "/api/state", field: "audit.count", baseEquals: 0, headEquals: 0 },
        },
        guardrails: ["Case 42"],
      }),
    /must differ/,
  )
})

test("resolves a dotted oracle field", () => {
  assert.equal(resolveField({ audit: { events: 1 } }, "audit.events"), 1)
  assert.equal(resolveField({ audit: {} }, "audit.events"), undefined)
})

test("formats content-addressed evidence without session capabilities", () => {
  const revision = (label: "base" | "head", actual: number) => ({
    label,
    requestedCommit: label === "base" ? base : head,
    observedCommit: label === "base" ? base : head,
    status: "completed" as const,
    httpStatus: 200,
    pageTitle: "Synthetic claims desk",
    visibleTextObserved: true,
    oracleExpected: actual,
    oracleActual: actual,
    oracleMatched: true,
    screenshotCaptured: true,
    replayCaptured: true,
    steps: [{ name: "Verify", status: "passed" as const, durationMs: 500 }],
    error: null,
  })
  const report: ProofReport = {
    schemaVersion: 1,
    name: "PatchProof",
    status: "passed",
    repo: "https://github.com/example/app.git",
    baseCommit: base,
    headCommit: head,
    contractPath: "patchproof.config.json",
    contractSha256: "a".repeat(64),
    commitsBetween: 1,
    journey: "approval writes one audit event",
    oracle: { path: "/api/case", field: "audit.events", baseEquals: 0, headEquals: 1 },
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:02.000Z",
    durationMs: 2_000,
    revisions: [revision("base", 0), revision("head", 1)],
    artifacts: [{ path: "head/screenshot.png", bytes: 42, sha256: "b".repeat(64) }],
    error: null,
  }

  const markdown = formatMarkdown(report)
  assert.match(markdown, /PATCH PROVEN/)
  assert.match(markdown, /Content-addressed artifacts/)
  assert.match(markdown, /Ephemeral Solari session IDs, preview URLs, and API keys/)
  assert.doesNotMatch(markdown, /session-[0-9]/)
})
