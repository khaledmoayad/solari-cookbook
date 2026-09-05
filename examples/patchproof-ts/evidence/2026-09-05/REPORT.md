# PatchProof report

✅ PATCH PROVEN

**approving a synthetic authorization writes exactly one audit event**

The same workflow was executed against two immutable commits. The base reproduced
the declared state, the head produced the declared fixed state, and the visible
guardrails held in both isolated runs.

| Evidence | Base | Head |
| --- | --- | --- |
| Commit | ddf6bb3303508d8c981328d3128b22780a1de039 | 582715e93c7b14fd012cafeacb515d0d12206d78 |
| Visible workflow | observed | observed |
| Oracle: auditEvents | 0 (expected 0) | 1 (expected 1) |
| Screenshot | captured | captured |
| Recorded replay | captured | captured |

| Field | Value |
| --- | --- |
| Repository | https://github.com/khaledmoayad/solari-cookbook.git |
| Contract | patchproof.config.json |
| Contract SHA-256 | `a77e7117b5276fdb174cc830a59595df39c8a6fbcf8369c4950aba02961f87d5` |
| Verified commits between base and head | 1 |
| Oracle endpoint | /api/case |
| Duration | 49.9s |

## Execution trace

| Revision | Step | Status | Time | Detail |
| --- | --- | --- | ---: | --- |
| base | Create isolated sandbox | passed | 0.9s |  |
| base | Check out immutable commit | passed | 2.1s | ddf6bb330350 |
| base | Run setup command | passed | 0.2s | exit 0 |
| base | Start preview server | passed | 1.1s | port 3000 ready |
| base | Run recorded browser journey | passed | 10.2s | HTTP 200, visible workflow captured |
| base | Read state oracle | passed | 0.6s | auditEvents = 0 |
| base | Release isolated sandbox | passed | 0.4s | server stopped, sandbox destroyed |
| base | Download audit replay | passed | 7.4s | 12,191 bytes |
| head | Create isolated sandbox | passed | 0.3s |  |
| head | Check out immutable commit | passed | 1.8s | 582715e93c7b |
| head | Run setup command | passed | 0.2s | exit 0 |
| head | Start preview server | passed | 1.2s | port 3000 ready |
| head | Run recorded browser journey | passed | 10.3s | HTTP 200, visible workflow captured |
| head | Read state oracle | passed | 0.6s | auditEvents = 1 |
| head | Release isolated sandbox | passed | 0.4s | server stopped, sandbox destroyed |
| head | Download audit replay | passed | 10.4s | 12,191 bytes |

## Content-addressed artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| [base/setup.log](base/setup.log) | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| [base/app.log](base/app.log) | 55 | `101c96e41268c738efb435c4467b164472b7ed10c1e158cc0acc402ae6bc910e` |
| [base/screenshot.png](base/screenshot.png) | 127,683 | `f4afcf9177884aa06d4fc75302ab8ab81541bb9a008fad832f7ed55efbbfbaad` |
| [base/replay.ndjson](base/replay.ndjson) | 12,191 | `f839027ce2a7577406333ad6a04098b2cb7fcc8277880471ffcd9946912b4089` |
| [head/setup.log](head/setup.log) | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| [head/app.log](head/app.log) | 55 | `101c96e41268c738efb435c4467b164472b7ed10c1e158cc0acc402ae6bc910e` |
| [head/screenshot.png](head/screenshot.png) | 127,683 | `f4afcf9177884aa06d4fc75302ab8ab81541bb9a008fad832f7ed55efbbfbaad` |
| [head/replay.ndjson](head/replay.ndjson) | 12,191 | `d1029bbbef03830a6ffaceebed3baacaa8636d47ca5672037a15330ed2d077be` |

Generated at 2026-09-05T23:21:00.333Z. Ephemeral Solari session IDs, preview URLs, and API keys are intentionally omitted.
