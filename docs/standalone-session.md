# Standalone sessions and tools

English · [简体中文](standalone-session.zh-CN.md)

The browser player and manual sessions share the same app runtime, RuntimeCore and z8lua VM. Import from the complete static component's `main/player.mjs` (also recorded in `manifest.artifacts.main.path`). Workspace consumers can use the `@pico8-player/player` package root.

Node.js can import an extracted component without DOM, Worker, repository source or `node_modules`. Keep the component's sibling WASM/assets directories intact.

## JSON tool adapter

```js
import { createPico8Session, createPico8SessionTool } from "./main/player.mjs";

const session = await createPico8Session();
const tool = createPico8SessionTool(session);
try {
  await tool.execute({ action: "load_source", source: `
    x=0
    function _update60()
      if btn(1) then x+=1 end
    end
    function _draw()
      cls(0)
      pset(x,0,8)
    end
  ` });
  const result = await tool.execute({ action: "advance", frames: 30, buttons: 2 });
  // completedFrames === 30; observation.frame.frameId === 29.
  // The image contains 128 × 128 RGBA8 bytes in base64, not a PNG/JPEG.
  await tool.execute({ action: "advance", frames: 1, buttons: 0 });
  const metadata = await tool.execute({ action: "observe", image: false });
} finally {
  await session.dispose();
}
```

`tool.name`, `description`, `inputSchema` and `execute` form a platform-neutral adapter. The integrating application owns Codex/Pi/MCP registration, transport and image-content formatting. Player does not install plugins, access host projects or call a model.

The tool accepts source, frame counts, buttons and observation operations. It does not provide JavaScript evaluation, filesystem access or URL-based cartridge authority.

## Direct session API

| Method | Contract |
| --- | --- |
| `loadSource(source, options?)` | Load PICO-8 Lua. Successful initialization returns `ready`; guest/compiler failures return a faulted observation with diagnostics. Invalid API arguments reject. |
| `loadCart(bytes, options?)` | Decode a complete `.p8` or `.p8.png`, including assets. External dependencies require an explicit local bundle. |
| `advance({ frames, input? })` | Execute 1–600 logical frames. Held buttons apply to the entire batch; devkit keypress/wheel/movement transients apply only to its first frame. Omitted input releases buttons. |
| `observe()` | Return a synchronous copied snapshot without running guest code. |
| `reset()` | Cold-start a new generation of the current cartridge. Source revision and instance memory cartdata are retained. |
| `dispose()` | Idempotently release the session and WASM references; reject queued operations that have not started. |

An advance result contains `requestedFrames`, `completedFrames`, `outcome` and `observation`. Guest stop, fault or cartridge replacement can end a batch early. A replacement session does not continue inside the same batch. Batches finish paused with input cleared.

Observations include session ID, source revision, generation, state, the most recent committed frame and up to 64 diagnostics. A null frame means no frame has completed; observation does not implicitly call `_draw()`. Frames contain copied RGBA, packed screen and display palette arrays, frame number, FPS, instruction count and slow-frame status. Consumers may modify their copies independently.

Disposal can end a running batch between frames. A same-thread timer cannot preempt a single synchronous WASM call already in progress.

## Persistence and execution

Persistence defaults to `"memory"`, isolated per instance. `{ persistence: "indexeddb" }` explicitly enables durable browser storage. Reset does not erase saves; create a new memory session when a clean environment is required.

The real-time facade uses `createPico8Player({ root })`, with `execution: "worker"` as an optional adapter. Manual stepping does not require that facade or an audio device. Browser API v2 and standalone API v1 are distinct interfaces over shared execution.

Main-thread execution has a deterministic VM instruction cap, but does not promise bounded UI latency for every cartridge. Node.js covers device-free sessions/tool loops; Chrome/Chromium remains the browser target.

## Logs

`session.readLogs(after = 0)` non-destructively returns `{ cursor, dropped, entries }`. Each entry contains `sequence`, `frameId`, `text` and `truncated`. Follow the returned cursor after successful delivery; reset your cursor after load/reset because sequence numbers belong to the current VM.

The buffer holds at most 64 entries and 8 KiB of raw bytes, with a 1 KiB per-entry limit. Frame IDs refer to attempted frames; initialization logs use null, and a fault can prevent the attempted frame from committing. Non-ASCII P8 bytes use `\xNN` escapes rather than lossy UTF-8 decoding.

Reading logs does not advance frames or change saves. The final snapshot is retained before a fault destroys the VM. Filename arguments do not grant filesystem access. This API belongs to manual sessions, not the real-time player controls.

## Audio call events

With `createPico8Session({ inspection: true })`, advance results additionally include `audio: { events, dropped }` for guest calls that start sound:

- `sfx`: `{ frameId, sfx, channel, overMusic }`, with the actual allocated channel and whether it replaced a music channel.
- `music`: `{ frameId, music }`, where `-1` means stop.

Initialization calls arrive with the first advance result. Each result includes up to 32 events and counts overflow in `dropped`. Automatic music-pattern progression does not emit calls. These events establish invocation/channel allocation, not subjective sound quality. Non-inspection sessions omit this field.

## Inspection and debugging

Enable inspection explicitly, then query at a safe boundary after at least one completed frame:

```js
const session = await createPico8Session({ inspection: true });
// Load and advance a cartridge that defines g.board and g.moves first.
const snapshot = await session.inspect({
  mode: "read", paths: [["g", "board"], ["g", "moves"]],
});
const debug = await session.inspect({ mode: "debug", code: "g.moves=1; return g.moves" });
```

Inspection sessions use memory persistence and cannot simultaneously enable IndexedDB. The real-time browser facade does not expose inspection. The JSON session tool keeps its existing input surface; hosts can expose their own inspection tool using the public session API.

`prepareInspection` and `INSPECTION_LIMITS` provide public validation and bounds:

| Input | Limit |
| --- | --- |
| Read paths | 1–16 paths, each 1–16 segments |
| Path segments | Global string first; then strings or signed 16-bit integers |
| String key | 128 bytes |
| Total input | 4 KiB |
| Debug chunk | 1–4096 bytes; fixed 50,000-instruction budget |

Keys and code map code points 0–255 directly to Lua bytes, without Unicode/P8SCII glyph conversion.

Results are copied JSON snapshots: `{ ok, executed, values, error?, truncated? }`. Tables retain sparse entries and key types using `{ type: "table", entries: [{ key, value }] }`. Unsupported value kinds return type tags, never addresses. Cycles, depth beyond 4, more than 512 entries and the 16 KiB byte cap are explicitly marked. Byte overflow returns empty values and `truncated: "bytes"`; narrow the query and retry.

Read mode uses raw access and pauses GC, avoiding metamethods and finalizers. It does not change simulation time, randomness, input or RAM.

Debug chunks run at a protected boundary without an implicit frame or update/draw. They cannot use run/stop/reset/load/reload/cstore/cartdata/dset/extcmd/flip/yield or host suspension; cached aliases, protected calls and nested coroutines cannot bypass that restriction. `printh` uses the same bounded log buffer.

A successful debug chunk or compile failure leaves the last completed frame unchanged until the next advance. **An executed error or budget overrun does not roll back partial writes.** Raw reads remain available, but further debug/advance operations require reset or reload. Hosts should record debug purpose before execution and treat interruption or lost responses as an uncertain debug outcome. Dispose and recreate the memory session to clear both debug effects and in-memory saves.

The ABI entry point and binary layouts are recorded in [`spec/abi/p8w-v1.json`](../spec/abi/p8w-v1.json). Source, WASM hashes and exports are checked by locks and reproducible builds.
