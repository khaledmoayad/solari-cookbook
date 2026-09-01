# PatchProof (TypeScript)

**The screenshot passed. The patch did not.**

PatchProof proves that one exact code change caused one exact behavioral change:

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
secure. It answers one narrower question: **did this patch cause the behavior its
author promised?**

## Why the oracle matters

The included synthetic claims fixture reports “Authorization approved” in both
revisions. In the base commit, however, it silently fails to persist the required
audit event. A screenshot alone looks green. The contract checks
`GET /api/case → auditEvents`, requiring `0` at base and `1` at head.

No patient or production data is used.

## Run

Requirements: Node.js 20+, a public GitHub repository, two immutable commits,
and a [Solari API key](https://console.getsolari.com).

```bash
cd examples/patchproof-ts
npm install
export SOLARI_API_KEY=slr_live_...

npm start -- \
  --repo https://github.com/your-name/solari-cookbook.git \
  --base <40-character-bug-commit> \
  --head <40-character-fix-commit>
```

The default contract is [`patchproof.config.json`](patchproof.config.json).
Use `--contract`, `--output`, or `--timeout` to override the local file, proof
directory, or per-stage timeout. Run `npm start -- --help` for the full CLI.

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
and SHA-256 hashes for every retained artifact. Ephemeral session IDs, preview
URLs, and the API key are deliberately excluded. The key never enters either
sandbox.

## Verify locally

```bash
npm run check
npm audit --audit-level=high
```

Source: [`index.ts`](index.ts). The implementation uses only Node’s standard
library plus the two official Solari SDKs.

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
      - uses: actions/checkout@v4
      - id: proof
        uses: khaledmoayad/solari-cookbook/examples/patchproof-ts@feat/patchproof
        with:
          solari-api-key: ${{ secrets.SOLARI_API_KEY }}
          repo: ${{ github.server_url }}/${{ github.repository }}.git
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: patchproof
          path: ${{ steps.proof.outputs.proof-directory }}
```

The key is passed only to the local Solari clients. It is not injected into
either sandbox or written to the proof bundle.
