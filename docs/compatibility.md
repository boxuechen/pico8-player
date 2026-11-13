# Compatibility

The target is the **PICO-8 v0.2.7 cartridge runtime**. Supported inputs are `.p8`, `.p8.png`, and Lua source through the standalone API. Chrome/Chromium is the browser verification target; Node.js supports sessions and tools without device output.

The [API inventory](../spec/pico-api-inventory.yaml) records implementation status and supported profiles. Behavioral evidence lives in `tests/runtime` and `tests/fixtures`. A tested compatibility profile is not a claim of universal cartridge support or bit-exact official output.

| Area | Current boundary |
| --- | --- |
| Main-thread execution | Deterministic VM instruction cap; no preemptive wall-clock watchdog. A long synchronous WASM call occupies the UI thread. |
| `stat` | Supported deterministic selectors return their defined values; unsupported selectors return `false`. |
| Timed P8SCII | Delay controls do not suspend the guest; text time advances with logical frames. |
| Fractional powers | z8lua's floating-point path is not claimed to be bit-exact with the official runtime. |
| Screen modes | Standard packed 4bpp; advanced bitplane modes are outside the current scope. |
| Nested guest coroutines | Root-only resumable operations include `flip/run/stop/load`, external `reload/cstore`, and host requests. Nested suspension is rejected without external side effects. |
| Nested custom loops | CPU accounting continues; frame commit waits for the root to return. A non-returning loop reaches the hard cap. |
| Debugging | Copied frames, structured diagnostics, bounded `printh` logs and opt-in standalone inspection/debug chunks. No breakpoint debugger or unrestricted live evaluation. |

`flip`, `printh`, `stat`, `print` and `extcmd` have bounded support profiles. Console/platform capabilities such as `save/folder/ls/resume/reboot/info/serial` are unsupported. Check the inventory for exact modes rather than inferring full support from the presence of a function name.

The component does not include the PICO-8 editor, SPLORE, system console or export toolchain. It executes caller-provided or explicitly authorized bytes; it has no automatic BBS access, arbitrary-URL cartridge loader or guest host-filesystem access.

Source and license ownership are documented in [third-party notices](../THIRD_PARTY_NOTICES.md). The project is independent of Lexaloffle.
