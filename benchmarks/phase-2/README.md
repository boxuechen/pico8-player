# Phase 2 exit measurements

This suite records the Phase 2F production Chrome gate for the project-authored
`graphics-memory` and `text-remap` carts. It contains deterministic Worker
trace/screen/palette hashes, exact Canvas RGBA results, per-cart Worker
round-trip samples, and resource-fault recovery observations.

Smoke artifacts are ignored. The reviewed evidence file is generated only by
`pnpm run evidence:phase-2f` and is linked from the immutable Phase 2 evidence
record. It does not contain or depend on BBS, third-party cart, or `ref/`
content.
