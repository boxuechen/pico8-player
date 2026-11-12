# Upstream patches

Patches apply in numeric order to the exact commit in `../source.lock.json`.
`manifest.json` records purpose, checksum, enabling flag, regression tests, and
upstream status. The vendored tree contains the applied result; source inventory
verification prevents unrecorded drift.

Patch 0001 compiles privileged/non-PICO base functions out of the
registration table. The bridge still removes the same globals defensively.

Patch 0002 replaces z8lua's lower-32-KiB flat direct-operator reader
with calls into the project-owned Pico address mapper. The mapper remains in
`wasm/bridge/`; the patch does not add a competing copy of remap semantics to
the vendored VM.
