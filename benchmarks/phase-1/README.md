# Phase 1 L1 exit measurements

This suite records the Phase 1F production Chrome gate for project-authored
30Hz callback, 60Hz generated `.p8.png` callback and 30Hz custom-loop carts.
It contains deterministic trace/screen hashes, real-rAF pacing, keyboard and
fault recovery observations, and the ordinary 60Hz Worker round-trip sample.

Smoke artifacts are ignored. The reviewed evidence file is generated only by
`pnpm run evidence:phase-1f` and is linked from the immutable Phase 1 evidence
record. It does not contain or depend on BBS or third-party cart content.
