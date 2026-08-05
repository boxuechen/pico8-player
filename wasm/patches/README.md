# Upstream patches

Patches apply in numeric order to the exact commit in `../source.lock.json`.
`manifest.json` records purpose, checksum, enabling flag, regression tests, and
upstream status. The vendored tree contains the applied result; source inventory
verification prevents unrecorded drift.

Phase 0A has one project-specific patch: it compiles privileged/non-PICO base
functions out of the registration table. The bridge still removes the same
globals defensively.
