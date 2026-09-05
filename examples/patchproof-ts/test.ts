import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  formatMarkdown,
  parseContract,
  readConfig,
  resolveField,
  run,
  sanitizeReplay,
  targetUrl,
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

test("fixture records exactly one in-memory audit event", async (context) => {
  const port = 41_842
  const directory = fileURLToPath(new URL(".", import.meta.url))
  const fixture = spawn(process.execPath, ["fixture/server.mjs"], {
    cwd: directory,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  })
  context.after(() => {
    if (fixture.exitCode === null) fixture.kill()
  })

  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${url}/api/approve`, { method: "POST" })
    assert.equal(response.status, 200)
  }
  const state = await (await fetch(`${url}/api/case`)).json()
  assert.deepEqual(state, { authorization: "approved", auditEvents: 1 })

  fixture.kill()
  await once(fixture, "exit")
})

test("contract paths cannot escape the checkout or send preview tokens off-origin", async () => {
  const contract = JSON.parse(await readFile(new URL("patchproof.config.json", import.meta.url), "utf8"))
  assert.equal(parseContract({ ...contract, workdir: "." }).workdir, ".")
  for (const workdir of ["..", "../other", "/tmp", "a/../../other"]) {
    assert.throws(() => parseContract({ ...contract, workdir }), /repository-relative/)
  }
  const preview = "https://demo.preview.getsolari.com/?token=test-only"
  for (const pathname of ["//example.org", "/\\example.org", "/\n/example.org", "https://example.org"]) {
    assert.throws(() => targetUrl(preview, pathname), /same-origin/)
    assert.throws(() => parseContract({ ...contract, journey: { ...contract.journey, path: pathname } }), /same-origin/)
    assert.throws(() => parseContract({
      ...contract,
      journey: { ...contract.journey, oracle: { ...contract.journey.oracle, path: pathname } },
    }), /same-origin/)
  }
  assert.equal(targetUrl(preview, "/api/case?view=full"), "https://demo.preview.getsolari.com/api/case?view=full&token=test-only")
})

test("replay remains valid NDJSON without Solari capabilities", () => {
  const events = [
    { type: 4, data: { href: "https://demo.preview.getsolari.com/?token=test-only" } },
    { type: 2, data: { node: { textContent: "Authorization approved", key: "slr_test_fake_example_only_12345" } } },
  ]
  const replay = sanitizeReplay(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n")))
  const restored = replay.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(restored[1].data.node.textContent, "Authorization approved")
  assert.doesNotMatch(replay, /getsolari\.com|test-only|slr_test_/)
  assert.throws(() => sanitizeReplay(Buffer.from('{"type":4}')), /no DOM snapshot/)
})

test("reruns refuse to overwrite or reuse prior evidence", async (context) => {
  const output = await mkdtemp(path.join(tmpdir(), "patchproof-evidence-test-"))
  context.after(() => rm(output, { recursive: true, force: true }))
  const prior = path.join(output, "prior-evidence.txt")
  await writeFile(prior, "keep this")
  const config = readConfig(["--repo", "https://github.com/example/app", "--base", base, "--head", head, "--output", output])
  if (config === "help") assert.fail("expected config")
  await assert.rejects(run(config, "unused"), /Output directory must be empty/)
  assert.equal(await readFile(prior, "utf8"), "keep this")
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
