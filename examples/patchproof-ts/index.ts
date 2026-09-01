/**
 * PatchProof — prove that one exact commit changes one exact behavior.
 *
 * The same browser journey runs against immutable base and head commits in
 * separate Solari sandboxes. A recorded browser checks the visible workflow;
 * a JSON oracle checks the state behind the screen.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"

import { Solari, SolariError } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

const APP_DIR = "/tmp/patchproof-app"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type JsonPrimitive = string | number | boolean | null
type RevisionLabel = "base" | "head"

export interface Contract {
  version: 1
  workdir: string
  setup: string
  start: string
  port: number
  journey: {
    name: string
    path: string
    click: {
      role: "button" | "link"
      name: string
    }
    expectText: string
    oracle: {
      path: string
      field: string
      baseEquals: JsonPrimitive
      headEquals: JsonPrimitive
    }
  }
  guardrails: string[]
}

export interface Config {
  repo: string
  base: string
  head: string
  contractPath: string
  output: string
  timeoutMs: number
}

interface Step {
  name: string
  status: "passed" | "failed"
  durationMs: number
  detail?: string
}

export interface RevisionReport {
  label: RevisionLabel
  requestedCommit: string
  observedCommit: string | null
  status: "completed" | "error"
  httpStatus: number | null
  pageTitle: string | null
  visibleTextObserved: boolean
  oracleExpected: JsonPrimitive
  oracleActual: JsonPrimitive | null
  oracleMatched: boolean
  screenshotCaptured: boolean
  replayCaptured: boolean
  steps: Step[]
  error: string | null
}

interface Artifact {
  path: string
  bytes: number
  sha256: string
}

export interface ProofReport {
  schemaVersion: 1
  name: "PatchProof"
  status: "passed" | "failed"
  repo: string
  baseCommit: string
  headCommit: string
  contractPath: string
  contractSha256: string
  commitsBetween: number | null
  journey: string
  oracle: {
    path: string
    field: string
    baseEquals: JsonPrimitive
    headEquals: JsonPrimitive
  }
  startedAt: string
  finishedAt: string
  durationMs: number
  revisions: RevisionReport[]
  artifacts: Artifact[]
  error: string | null
}

const HELP = `PatchProof

Prove a code change by running the same browser journey against immutable base
and head commits in separate Solari sandboxes.

Usage:
  npm start -- --repo <github-url> --base <sha> --head <sha> [options]

Options:
  --repo <url>       Public GitHub repository (required)
  --base <sha>       Exact 40-character commit that reproduces the bug
  --head <sha>       Exact 40-character commit that contains the fix
  --contract <file>  Journey contract (default: patchproof.config.json)
  --output <dir>     Proof bundle directory (default: proof)
  --timeout <secs>   Per-stage timeout, 20-600 (default: 120)
  --help             Show this help

Setup and server commands execute only inside disposable Solari sandboxes.`

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a string`)
  return value
}

function primitive(value: unknown, name: string): JsonPrimitive {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as JsonPrimitive
  }
  throw new Error(`${name} must be a JSON primitive`)
}

export function parseContract(value: unknown): Contract {
  const root = object(value, "contract")
  if (root.version !== 1) throw new Error("contract.version must be 1")

  const workdir = string(root.workdir, "contract.workdir")
  const normalizedWorkdir = path.posix.normalize(workdir)
  if (
    path.posix.isAbsolute(workdir) ||
    normalizedWorkdir === "." ||
    normalizedWorkdir.startsWith("../") ||
    normalizedWorkdir !== workdir.replace(/\/$/, "")
  ) {
    throw new Error("contract.workdir must be a normalized repository-relative path")
  }

  const setup = string(root.setup, "contract.setup")
  const start = string(root.start, "contract.start")
  const port = root.port
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("contract.port must be an integer from 1 to 65535")
  }

  const journey = object(root.journey, "contract.journey")
  const click = object(journey.click, "contract.journey.click")
  const role = string(click.role, "contract.journey.click.role")
  if (role !== "button" && role !== "link") {
    throw new Error("contract.journey.click.role must be button or link")
  }

  const pathname = string(journey.path, "contract.journey.path")
  if (!pathname.startsWith("/")) throw new Error("contract.journey.path must start with /")

  const oracle = object(journey.oracle, "contract.journey.oracle")
  const oraclePath = string(oracle.path, "contract.journey.oracle.path")
  if (!oraclePath.startsWith("/")) throw new Error("contract.journey.oracle.path must start with /")
  const field = string(oracle.field, "contract.journey.oracle.field")
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(field)) {
    throw new Error("contract.journey.oracle.field must be a dotted object path")
  }

  const baseEquals = primitive(oracle.baseEquals, "contract.journey.oracle.baseEquals")
  const headEquals = primitive(oracle.headEquals, "contract.journey.oracle.headEquals")
  if (isDeepStrictEqual(baseEquals, headEquals)) {
    throw new Error("baseEquals and headEquals must differ to prove a change")
  }

  if (!Array.isArray(root.guardrails) || root.guardrails.length === 0) {
    throw new Error("contract.guardrails must contain at least one visible-text invariant")
  }
  const guardrails = root.guardrails.map((item, index) =>
    string(item, `contract.guardrails[${index}]`),
  )

  return {
    version: 1,
    workdir: normalizedWorkdir,
    setup,
    start,
    port: port as number,
    journey: {
      name: string(journey.name, "contract.journey.name"),
      path: pathname,
      click: {
        role,
        name: string(click.name, "contract.journey.click.name"),
      },
      expectText: string(journey.expectText, "contract.journey.expectText"),
      oracle: {
        path: oraclePath,
        field,
        baseEquals,
        headEquals,
      },
    },
    guardrails,
  }
}

export function readConfig(argv: string[]): Config | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      contract: { type: "string", default: "patchproof.config.json" },
      output: { type: "string", default: "proof" },
      timeout: { type: "string", default: "120" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) return "help"

  const { repo, base, head } = values
  if (!repo) throw new Error("--repo is required")
  if (!base) throw new Error("--base is required")
  if (!head) throw new Error("--head is required")

  const repoUrl = new URL(repo)
  if (
    repoUrl.protocol !== "https:" ||
    repoUrl.hostname !== "github.com" ||
    repoUrl.username ||
    repoUrl.password ||
    repoUrl.search ||
    repoUrl.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(repoUrl.pathname)
  ) {
    throw new Error("--repo must be a public github.com HTTPS repository without credentials")
  }

  const commitPattern = /^[0-9a-f]{40}$/i
  if (!commitPattern.test(base)) throw new Error("--base must be an exact 40-character commit")
  if (!commitPattern.test(head)) throw new Error("--head must be an exact 40-character commit")
  if (base.toLowerCase() === head.toLowerCase()) throw new Error("--base and --head must differ")

  const timeoutSeconds = Number(values.timeout)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 20 || timeoutSeconds > 600) {
    throw new Error("--timeout must be between 20 and 600 seconds")
  }

  return {
    repo,
    base: base.toLowerCase(),
    head: head.toLowerCase(),
    contractPath: path.resolve(values.contract),
    output: path.resolve(values.output),
    timeoutMs: timeoutSeconds * 1000,
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/slr_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/https:\/\/[^\s]+\.preview\.getsolari\.com[^\s]*/g, "[REDACTED_PREVIEW_URL]")
}

function tail(text: string, max = 4_000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

async function verifyAncestry(repo: string, base: string, head: string): Promise<number> {
  const pathname = new URL(repo).pathname
    .replace(/^\//, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
  const response = await fetch(
    `https://api.github.com/repos/${pathname}/compare/${base}...${head}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "solari-patchproof",
        "x-github-api-version": "2022-11-28",
      },
    },
  )
  if (!response.ok) throw new Error(`GitHub ancestry check returned HTTP ${response.status}`)

  const comparison = (await response.json()) as {
    status?: string
    ahead_by?: number
    merge_base_commit?: { sha?: string }
  }
  if (
    comparison.status !== "ahead" ||
    comparison.merge_base_commit?.sha?.toLowerCase() !== base ||
    !Number.isInteger(comparison.ahead_by) ||
    (comparison.ahead_by ?? 0) < 1
  ) {
    throw new Error("--head must descend from --base by at least one commit")
  }
  return comparison.ahead_by as number
}

async function waitForPreview(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = "no response"

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow" })
      last = `HTTP ${response.status}`
      if (response.status < 500) return response.status
    } catch (error) {
      last = safeError(error)
    }
    await sleep(1_000)
  }

  throw new Error(`app was not ready after ${timeoutMs / 1000}s (${last})`)
}

async function downloadReplay(client: Solari, sessionId: string): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(3_000)
    try {
      return await client.sessions.downloadReplay(sessionId)
    } catch (error) {
      if (error instanceof SolariError && error.status === 404) continue
      throw error
    }
  }
  throw new Error("browser replay was not available after 30 seconds")
}

function targetUrl(previewUrl: string, pathname: string): string {
  const preview = new URL(previewUrl)
  const target = new URL(pathname, preview)
  for (const [key, value] of preview.searchParams) target.searchParams.append(key, value)
  return target.toString()
}

export function resolveField(value: unknown, field: string): unknown {
  let current = value
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

async function runRevision(
  label: RevisionLabel,
  commit: string,
  contract: Contract,
  config: Config,
  platform: SolariClient,
  browserClient: Solari,
): Promise<RevisionReport> {
  const expected = label === "base" ? contract.journey.oracle.baseEquals : contract.journey.oracle.headEquals
  const report: RevisionReport = {
    label,
    requestedCommit: commit,
    observedCommit: null,
    status: "error",
    httpStatus: null,
    pageTitle: null,
    visibleTextObserved: false,
    oracleExpected: expected,
    oracleActual: null,
    oracleMatched: false,
    screenshotCaptured: false,
    replayCaptured: false,
    steps: [],
    error: null,
  }

  const output = path.join(config.output, label)
  await mkdir(output, { recursive: true })
  await Promise.all(
    ["screenshot.png", "replay.ndjson"].map((file) => rm(path.join(output, file), { force: true })),
  )

  let sandbox: Awaited<ReturnType<typeof platform.sandboxes.create>> | undefined
  let browser: Awaited<ReturnType<typeof browserClient.launch>> | undefined
  let server: Awaited<ReturnType<NonNullable<typeof sandbox>["commands"]["start"]>> | undefined
  let setupLog = ""
  let appLog = ""

  const step = async <T>(name: string, action: () => Promise<T>, detail?: (value: T) => string) => {
    const started = Date.now()
    try {
      const value = await action()
      report.steps.push({
        name,
        status: "passed",
        durationMs: Date.now() - started,
        detail: detail?.(value),
      })
      console.log(`✓ ${label}: ${name}`)
      return value
    } catch (error) {
      report.steps.push({
        name,
        status: "failed",
        durationMs: Date.now() - started,
        detail: safeError(error),
      })
      throw error
    }
  }

  try {
    sandbox = await step("Create isolated sandbox", () =>
      platform.sandboxes.create({
        template: "base",
        cpu: 1,
        memMb: 2_048,
        timeoutMs: config.timeoutMs + 120_000,
        lifecycle: { onTimeout: "kill" },
      }),
    )
    await sandbox.connect()

    await step(
      "Check out immutable commit",
      async () => {
        await sandbox!.files.mkdir(APP_DIR)
        const commands: Array<[string, string[], string?]> = [
          ["git", ["init"], APP_DIR],
          ["git", ["remote", "add", "origin", config.repo], APP_DIR],
          ["git", ["fetch", "--depth", "1", "origin", commit], APP_DIR],
          ["git", ["checkout", "--detach", "FETCH_HEAD"], APP_DIR],
        ]
        for (const [command, args, cwd] of commands) {
          const result = await sandbox!.commands.run(command, { args, cwd, timeoutMs: config.timeoutMs })
          if (result.exitCode !== 0) {
            throw new Error(`${command} ${args[0]} exited ${result.exitCode}: ${tail(result.stderr)}`)
          }
        }
        const resolved = await sandbox!.commands.run("git", { args: ["rev-parse", "HEAD"], cwd: APP_DIR })
        if (resolved.exitCode !== 0) throw new Error(`git rev-parse exited ${resolved.exitCode}`)
        report.observedCommit = resolved.stdout.trim().toLowerCase()
        if (report.observedCommit !== commit) {
          throw new Error(`checkout resolved ${report.observedCommit}, expected ${commit}`)
        }
        return report.observedCommit
      },
      (resolved) => resolved.slice(0, 12),
    )

    const workdir = path.posix.join(APP_DIR, contract.workdir)
    await step(
      "Run setup command",
      async () => {
        const result = await sandbox!.commands.run("sh", {
          args: ["-lc", contract.setup],
          cwd: workdir,
          timeoutMs: config.timeoutMs,
        })
        setupLog = `${result.stdout}${result.stderr}`
        if (result.exitCode !== 0) {
          throw new Error(`setup exited ${result.exitCode}: ${tail(result.stderr || result.stdout)}`)
        }
        return result.exitCode
      },
      () => "exit 0",
    )

    const previewUrl = await step(
      "Start preview server",
      async () => {
        server = await sandbox!.commands.start("sh", {
          args: ["-lc", contract.start],
          cwd: workdir,
          env: { HOST: "0.0.0.0", PORT: String(contract.port) },
        })
        server.onData(({ data }) => {
          appLog = tail(appLog + data, 50_000)
        })

        const { url } = await sandbox!.previewUrl(contract.port)
        const first = await Promise.race([
          waitForPreview(url, config.timeoutMs).then(() => ({ ready: true as const })),
          server.wait().then((code) => ({ ready: false as const, code })),
        ])
        if (!first.ready) throw new Error(`server exited ${first.code}: ${tail(appLog)}`)
        return url
      },
      () => `port ${contract.port} ready`,
    )

    const sessionId = await step(
      "Run recorded browser journey",
      async () => {
        browser = await browserClient.launch({ recording: true, retries: 2, probe: true })
        const id = browser.id
        try {
          const page = await browser.newPage()
          const response = await page.goto(targetUrl(previewUrl, contract.journey.path), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(config.timeoutMs, 60_000),
          })
          report.httpStatus = response?.status() ?? null
          if (!response?.ok()) throw new Error(`journey page returned HTTP ${report.httpStatus ?? "unknown"}`)
          report.pageTitle = await page.title()

          const before = await page.locator("body").innerText()
          for (const guardrail of contract.guardrails) {
            if (!before.includes(guardrail)) throw new Error(`visible guardrail not found: ${guardrail}`)
          }

          await page
            .getByRole(contract.journey.click.role, {
              name: contract.journey.click.name,
              exact: true,
            })
            .click({ timeout: Math.min(config.timeoutMs, 30_000) })
          await page
            .getByText(contract.journey.expectText, { exact: true })
            .waitFor({ state: "visible", timeout: Math.min(config.timeoutMs, 30_000) })
          report.visibleTextObserved = true

          const after = await page.locator("body").innerText()
          for (const guardrail of contract.guardrails) {
            if (!after.includes(guardrail)) throw new Error(`guardrail disappeared after action: ${guardrail}`)
          }

          const screenshot = await page.screenshot({ fullPage: true, type: "png" })
          await writeFile(path.join(output, "screenshot.png"), screenshot)
          report.screenshotCaptured = true
          return id
        } finally {
          await browser.close()
          browser = undefined
        }
      },
      () => `HTTP ${report.httpStatus}, visible workflow captured`,
    )

    await step(
      "Read state oracle",
      async () => {
        const response = await fetch(targetUrl(previewUrl, contract.journey.oracle.path))
        if (!response.ok) throw new Error(`oracle returned HTTP ${response.status}`)
        const payload: unknown = await response.json()
        const actual = resolveField(payload, contract.journey.oracle.field)
        if (actual === undefined) throw new Error(`oracle field not found: ${contract.journey.oracle.field}`)
        if (actual !== null && !["string", "number", "boolean"].includes(typeof actual)) {
          throw new Error(`oracle field is not a JSON primitive: ${contract.journey.oracle.field}`)
        }
        report.oracleActual = actual as JsonPrimitive
        report.oracleMatched = isDeepStrictEqual(report.oracleActual, expected)
        if (!report.oracleMatched) {
          throw new Error(
            `oracle mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
          )
        }
        return actual as JsonPrimitive
      },
      (actual) => `${contract.journey.oracle.field} = ${JSON.stringify(actual)}`,
    )

    await step(
      "Release isolated sandbox",
      async () => {
        if (server) await server.kill()
        server = undefined
        if (sandbox) await sandbox.kill()
        sandbox = undefined
      },
      () => "server stopped, sandbox destroyed",
    )

    await step(
      "Download audit replay",
      async () => {
        const replay = await downloadReplay(browserClient, sessionId)
        await writeFile(path.join(output, "replay.ndjson"), replay)
        report.replayCaptured = true
        return replay.length
      },
      (bytes) => `${bytes.toLocaleString()} bytes`,
    )

    report.status = "completed"
  } catch (error) {
    report.error = safeError(error)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    if (server) await server.kill().catch(() => undefined)
    if (sandbox) await sandbox.kill().catch(() => undefined)
    await writeFile(path.join(output, "setup.log"), setupLog)
    await writeFile(path.join(output, "app.log"), appLog)
  }

  return report
}

async function artifacts(output: string): Promise<Artifact[]> {
  const files = [
    "base/setup.log",
    "base/app.log",
    "base/screenshot.png",
    "base/replay.ndjson",
    "head/setup.log",
    "head/app.log",
    "head/screenshot.png",
    "head/replay.ndjson",
  ]
  const found: Artifact[] = []

  for (const relative of files) {
    const absolute = path.join(output, relative)
    try {
      const [data, metadata] = await Promise.all([readFile(absolute), stat(absolute)])
      found.push({ path: relative, bytes: metadata.size, sha256: sha256(data) })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
  }
  return found
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("`", "'").replaceAll("\n", " ")
}

function shown(value: JsonPrimitive | null): string {
  return JSON.stringify(value)
}

export function formatMarkdown(report: ProofReport): string {
  const verdict = report.status === "passed" ? "✅ PATCH PROVEN" : "❌ NOT PROVEN"
  const summary =
    report.status === "passed"
      ? `The same workflow was executed against two immutable commits. The base reproduced
the declared state, the head produced the declared fixed state, and the visible
guardrails held in both isolated runs.`
      : "The available evidence did not satisfy the complete base-to-head proof contract."
  const [base, head] = report.revisions
  const revisionRows = base && head
    ? [
        ["Commit", base.observedCommit ?? "unavailable", head.observedCommit ?? "unavailable"],
        ["Visible workflow", base.visibleTextObserved ? "observed" : "missing", head.visibleTextObserved ? "observed" : "missing"],
        [
          `Oracle: ${report.oracle.field}`,
          `${shown(base.oracleActual)} (expected ${shown(base.oracleExpected)})`,
          `${shown(head.oracleActual)} (expected ${shown(head.oracleExpected)})`,
        ],
        ["Screenshot", base.screenshotCaptured ? "captured" : "unavailable", head.screenshotCaptured ? "captured" : "unavailable"],
        ["Recorded replay", base.replayCaptured ? "captured" : "unavailable", head.replayCaptured ? "captured" : "unavailable"],
      ]
    : []

  const steps = report.revisions
    .flatMap((revision) =>
      revision.steps.map(
        (step) =>
          `| ${revision.label} | ${markdownCell(step.name)} | ${step.status} | ${(step.durationMs / 1000).toFixed(1)}s | ${markdownCell(step.detail ?? "")} |`,
      ),
    )
    .join("\n")

  const artifactRows = report.artifacts
    .map(
      (artifact) =>
        `| [${artifact.path}](${artifact.path}) | ${artifact.bytes.toLocaleString()} | \`${artifact.sha256}\` |`,
    )
    .join("\n")

  return `# PatchProof report

${verdict}

**${markdownCell(report.journey)}**

${summary}

| Evidence | Base | Head |
| --- | --- | --- |
${revisionRows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`).join("\n")}

| Field | Value |
| --- | --- |
| Repository | ${markdownCell(report.repo)} |
| Contract | ${markdownCell(report.contractPath)} |
| Contract SHA-256 | \`${report.contractSha256}\` |
| Verified commits between base and head | ${report.commitsBetween?.toString() ?? "unavailable"} |
| Oracle endpoint | ${markdownCell(report.oracle.path)} |
| Duration | ${(report.durationMs / 1000).toFixed(1)}s |

## Execution trace

| Revision | Step | Status | Time | Detail |
| --- | --- | --- | ---: | --- |
${steps}

## Content-addressed artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
${artifactRows}
${report.error ? `\n## Failure\n\n\`${markdownCell(report.error)}\`\n` : ""}
Generated at ${report.finishedAt}. Ephemeral Solari session IDs, preview URLs, and API keys are intentionally omitted.
`
}

export async function run(config: Config, apiKey: string): Promise<ProofReport> {
  await mkdir(config.output, { recursive: true })
  const contractBytes = await readFile(config.contractPath)
  const contract = parseContract(JSON.parse(contractBytes.toString("utf8")))
  const started = Date.now()
  const report: ProofReport = {
    schemaVersion: 1,
    name: "PatchProof",
    status: "failed",
    repo: config.repo,
    baseCommit: config.base,
    headCommit: config.head,
    contractPath: path.basename(config.contractPath),
    contractSha256: sha256(contractBytes),
    commitsBetween: null,
    journey: contract.journey.name,
    oracle: {
      path: contract.journey.oracle.path,
      field: contract.journey.oracle.field,
      baseEquals: contract.journey.oracle.baseEquals,
      headEquals: contract.journey.oracle.headEquals,
    },
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    durationMs: 0,
    revisions: [],
    artifacts: [],
    error: null,
  }

  const platform = new SolariClient({ apiKey })
  const browserClient = new Solari({ apiKey })

  try {
    report.commitsBetween = await verifyAncestry(config.repo, config.base, config.head)
    const base = await runRevision("base", config.base, contract, config, platform, browserClient)
    report.revisions.push(base)
    if (base.status !== "completed") throw new Error(`base run failed: ${base.error}`)

    const head = await runRevision("head", config.head, contract, config, platform, browserClient)
    report.revisions.push(head)
    if (head.status !== "completed") throw new Error(`head run failed: ${head.error}`)

    report.status = "passed"
  } catch (error) {
    report.error = safeError(error)
  } finally {
    await browserClient.close().catch(() => undefined)
    report.artifacts = await artifacts(config.output)
    const finished = Date.now()
    report.finishedAt = new Date(finished).toISOString()
    report.durationMs = finished - started
    await writeFile(path.join(config.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(config.output, "REPORT.md"), formatMarkdown(report))
  }

  return report
}

async function main() {
  try {
    const config = readConfig(process.argv.slice(2))
    if (config === "help") {
      console.log(HELP)
      return
    }

    const apiKey = process.env.SOLARI_API_KEY
    if (!apiKey) throw new Error("SOLARI_API_KEY is required; create one at console.getsolari.com")

    const report = await run(config, apiKey)
    console.log(`\n${report.status.toUpperCase()} — ${path.join(config.output, "REPORT.md")}`)
    if (report.status === "failed") {
      console.error(report.error)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`error: ${safeError(error)}\n\n${HELP}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
