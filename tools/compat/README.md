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

The versioned input/output contracts live in `spec/compat/`. The Phase 6 contract, not the example
files, owns the current minimum case count and browser gate.
