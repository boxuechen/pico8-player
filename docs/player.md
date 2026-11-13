# Embed the browser player

English · [简体中文](player.zh-CN.md)

Import `main/player.mjs` from a complete static component and load `player.css`. Keep the WASM, Worker and Worklet paths relative to the component. Serve it over HTTP(S); the [artifact contract](../spec/release-artifact-contract.json) defines its files, MIME types and CSP profile.

## Create, load and start

```js
import { createPico8Player } from "./player/main/player.mjs";

const player = await createPico8Player({
  root: document.querySelector("#player"),
  // execution: "worker", // Optional; defaults to the main thread.
  // shell: "hosted",     // Your application owns selection and controls.
});
const unsubscribe = player.on("fault", ({ error }) => console.error(error));

async function openCartridge(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await player.loadCart(bytes, { displayName: file.name });
  await player.start(); // The first frame has actually reached the Canvas.
}

// Call from your framework's unmount/teardown hook.
async function disposePlayer() {
  unsubscribe();
  await player.dispose();
}
```

Call `openCartridge` with a `File` selected by the user, or supply your own caller-owned `Uint8Array`. The player does not fetch a cartridge from an arbitrary URL. A `localCartBundle` grants explicit `load/reloadData/cstoreData/include` permissions for each reference.

Browser audio requires a user gesture. The built-in shell activates audio from trusted interaction; successful frame presentation alone does not guarantee audible output. Manual sessions are intended for stepping and observation, not real-time device playback.

## API and lifecycle

| Surface | Behavior |
| --- | --- |
| `loadCart`, `start`, `pause`, `resume`, `reset`, `stop` | Awaitable lifecycle operations |
| `flushPersistence`, `handleLifecycle`, `dispose` | Awaitable persistence, host lifecycle and teardown |
| `setInput` | Update the eight-player/devkit input snapshot |
| `state`, `root`, `canvas` | Read-only properties |
| `on(type, listener)` | Subscribe; returns an unsubscribe function |

Events are `state`, `frame`, `diagnostic`, `fault` and `persistence`. Frame events contain copied packed screen/palette data, frame ID, generation and CPU statistics.

API calls, UI controls and environment events use the same lifecycle queue. `start()` can reject on a fault, cancellation or first-frame deadline. `handleLifecycle("inactive" | "background" | "active")` connects application lifecycle events. After disposal, public events stop and required persistence/resource cleanup completes.

The exact options, events and methods are exported from [`public.ts`](../apps/player/src/main/public.ts). The browser facade uses API version 2.

## Persistence

The default browser player uses IndexedDB. To supply storage, pass a `persistence` adapter when creating the player:

```ts
interface HostPersistence {
  hydrate(contentId: string): Promise<readonly { id: string; bytes: Uint8Array }[]>;
  write(contentId: string, commit: {
    id: string;
    bytes: Uint8Array;
    revision: number;
  }): Promise<void>;
  flush(contentId: string): Promise<void>;
}
```

With a host adapter, every `loadCart` needs a stable `contentId`: 1–128 characters matching `[a-z0-9][a-z0-9:._-]*`. Each cartdata record is 256 bytes; its ID uses 1–64 characters from `[a-z0-9_-]`. The host must allow failed writes to be retried by a later flush.

Switching cartridges stops and flushes the old identity before hydrating the new one. Failure cannot silently write under the new identity. `flushPersistence(reason?)` returns `status`, `reason` and `durable`, with an optional failure message. A queued or saved event alone does not prove durable storage. Disposal waits for required final commits.

For a Lua → execute → observe loop without a UI, use [standalone sessions](standalone-session.md).
