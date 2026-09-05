# PatchProof (TypeScript)

**The screenshot passed. The patch did not.**

PatchProof checks a declared behavior change between two exact commits:

`base SHA + head SHA → isolated builds → same recorded journey → state oracle → hashed receipt`

It checks out immutable base and head commits in separate Solari sandboxes, runs
the same workflow in recorded Solari browsers, and verifies both the visible UI
and a machine-readable state oracle. A passing receipt means:

- the base reproduced the declared bug state;
- the head produced the declared fixed state;
- the expected UI and guardrail text held in both revisions;
- both checkouts resolved to the requested 40-character commits;
- GitHub confirmed that head descends from base; and
- the screenshots, replays, and logs were hashed into the receipt.

This is deliberately not a general test runner or a claim that the repository is
secure. It answers one narrower question: **did the same action produce the
declared state change, with the visible guardrails still present?** The oracle
comes from the tested app and is trusted. Hashes detect changes to saved files;
they are not independently signed attestations or proof of general correctness.

## Why the oracle matters

The included synthetic claims fixture reports “Authorization approved” in both
revisions. In the base commit, however, it silently fails to record the required
audit event. A screenshot alone looks green. The contract checks
`GET /api/case → auditEvents`, requiring `0` at base and `1` at head.

The fixture stores its counter in memory; it does not demonstrate durable
database persistence. No patient or production data is used.

## Live result

The [September 5 cloud run](evidence/2026-09-05/REPORT.md) passed in 49.9 seconds.
Both immutable checkouts matched, both browser journeys were recorded, and the
oracle returned `0` at base and `1` at head. The two screenshots look identical.
Each replay contains a DOM snapshot, one recorded click, and the approval text.

## Run

Requirements: Node.js 20+, a public GitHub repository, two immutable commits,
and a [Solari API key](https://console.getsolari.com).

```bash
git clone --branch feat/patchproof https://github.com/khaledmoayad/solari-cookbook.git
cd solari-cookbook/examples/patchproof-ts
npm install
export SOLARI_API_KEY=slr_live_...

npm start -- \
  --repo https://github.com/khaledmoayad/solari-cookbook.git \
  --base ddf6bb3303508d8c981328d3128b22780a1de039 \
  --head 582715e93c7b14fd012cafeacb515d0d12206d78
```

The default contract is [`patchproof.config.json`](patchproof.config.json).
Use `--contract`, `--output`, or `--timeout` to override the local file, proof
directory, or per-stage timeout. The output directory must be empty: use a new
`--output` when rerunning so prior evidence cannot be overwritten or mixed in.
Run `npm start -- --help` for the full CLI.

## Contract

```json
{
  "version": 1,
  "workdir": "examples/patchproof-ts/fixture",
  "setup": "true",
  "start": "node server.mjs",
  "port": 3000,
  "journey": {
    "name": "approving a synthetic authorization writes exactly one audit event",
    "path": "/",
    "click": { "role": "button", "name": "Approve authorization" },
    "expectText": "Authorization approved",
    "oracle": {
      "path": "/api/case",
      "field": "auditEvents",
      "baseEquals": 0,
      "headEquals": 1
    }
  },
  "guardrails": ["Synthetic data only", "Authorization PA-1842", "$1,240.00"]
}
```

Commands in the contract run only inside disposable sandboxes. PatchProof
accepts public `github.com` repositories and exact commits; moving branches,
embedded credentials, and repository paths that escape the checkout are rejected.
Base and head run sequentially on 1-vCPU/2-GB sandboxes, and each sandbox is
destroyed before PatchProof polls for the asynchronously uploaded replay.

The browser uses Solari's CDP endpoint and recorded default context. During the
live integration check, the wire-protocol `launch().newPage()` path completed the
workflow but returned no replay; CDP produced the recording successfully.

## Proof bundle

Successful and failed runs both write `proof/REPORT.md` and `proof/report.json`.
Each revision gets its own evidence directory:

| File | Evidence |
| --- | --- |
| `base/screenshot.png`, `head/screenshot.png` | Rendered result after the same action |
| `base/replay.ndjson`, `head/replay.ndjson` | Recorded browser sessions |
| `base/setup.log`, `head/setup.log` | Setup output from each isolated checkout |
| `base/app.log`, `head/app.log` | Application output from each revision |

The machine-readable receipt includes the repository, requested and observed
commits, exact contract SHA-256, expected and observed oracle values, timings,
and SHA-256 hashes for every retained artifact. Solari URLs, session IDs, and key
patterns are redacted from text artifacts before hashing. The key never enters
either sandbox. Recordings can still contain application data: inspect the
bundle before publishing anything other than synthetic fixtures.

## Verify locally

```bash
npm run check
npm audit --audit-level=high
```

Source: [`index.ts`](index.ts). The implementation uses only Node’s standard
library, the two official Solari SDKs, and the SDK's matching Patchright client
for its documented CDP connection.

## Gate a pull request

PatchProof is also a composite GitHub Action. Put the contract at the repository
root, store the key as `SOLARI_API_KEY`, and pass GitHub's immutable pull-request
commits:

```yaml
name: Prove patch
on: pull_request

jobs:
  patchproof:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - id: proof
        uses: khaledmoayad/solari-cookbook/examples/patchproof-ts@feat/patchproof
        with:
          solari-api-key: ${{ secrets.SOLARI_API_KEY }}
          repo: ${{ github.server_url }}/${{ github.repository }}.git
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: patchproof
          path: ${{ steps.proof.outputs.proof-directory }}
```

The key is passed only to the local Solari clients. It is not injected into
either sandbox or written to the proof bundle.
