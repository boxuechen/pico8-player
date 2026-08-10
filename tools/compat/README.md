# Local real-cart qualification tools

These tools consume only caller-supplied local files. They do not discover carts, fetch URLs, scan
`ref/`, copy cart bytes, or publish reports.

1. Copy `tests/conformance/local-corpus.example.json` to the ignored
   `tests/conformance/local-corpus.json` and provide 12–64 entries. Cart paths may point outside the
   repository or into the ignored `tests/conformance/local-corpus/` directory.
2. Produce `tests/conformance/local-observations.json` and local-only screenshots with:

   ```sh
   pnpm run qualification:phase-6c:local
   ```

   The harness uses the production Worker/WASM path and a loopback-only static server. It does not
   fetch the optional provenance URLs in the manifest.
3. Create the ignored report directory, then run:

   ```sh
   pnpm run qualification:local -- \
     --manifest tests/conformance/local-corpus.json \
     --observations tests/conformance/local-observations.json \
     --output tests/conformance/local-corpus-results/report.json
   ```

The CLI writes a new file only; it does not overwrite an existing report. Exit code `0` means every
manifest case has a complete observation, `2` means the report was written but has an incomplete case, and `1`
means the input or output policy failed. Reports omit cart paths, source URLs and permission free text.

A `C2` entry is not accepted from the smoke result alone. Add the `playability` object only after a
structured Chrome pass has satisfied either the 900-second duration gate or a complete critical flow.
The object records bounded input/visual/audio/persistence conclusions and the SHA-256 of ignored local
evidence; the runner rejects missing evidence, failed gates, crash/soft-lock claims, and evidence attached
to a non-C2 entry.

The versioned input/output contracts live in `spec/compat/`. The Phase 6 contract, not the example
files, owns the current minimum case count and browser gate.

## Phase 8 expanded format pairs

Phase 8 input remains outside the repository. Prepare the exact caller-authorized checkout with
`prepare:phase-8:local`, then run each of the three generated `format-pairs-batch-*.json` manifests
with `qualification:phase-8:chrome`. Expanded Chrome qualification requires the repository to stay
on one clean commit for the full batch; its observations and screenshots must also stay outside the
repository or in the ignored local-results directory.

After all three batches complete, run `qualification:phase-8:pairs` with the expanded index, the
three observation files, an aggregate output and an external `--local-details` output. The first run
may omit `--review` to discover representative screenshot categories. A final run supplies an
external review document containing only reviewer metadata, sample counts, severity counts and an
evidence digest. The tracked aggregate contract is
`spec/compat/expanded-format-pair-aggregate-v1.schema.json`; it deliberately cannot contain cart
identity, path, cart/screen hash, fault message, screenshot or per-pair result.
