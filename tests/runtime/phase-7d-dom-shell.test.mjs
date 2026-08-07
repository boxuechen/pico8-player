import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeIntegerScale,
  derivePlayerShellPresentation,
  isActivelyPlaying,
  MAX_LOCAL_CART_BYTES,
  validateLocalCartSelection,
} from "../../apps/web-player/dist/main/ui/player-shell-policy.js";

const STATES = [
  "idle",
  "loading",
  "ready",
  "running",
  "audio-blocked",
  "paused",
  "stopped",
  "faulted",
  "disposed",
];

test("every production shell state maps to explicit recoverable control policy", () => {
  const presentations = Object.fromEntries(STATES.map((state) => [
    state,
    derivePlayerShellPresentation({ state, hasRetainedCart: true, muted: false }),
  ]));
  assert.deepEqual(
    STATES.filter((state) => isActivelyPlaying(state)),
    ["running", "audio-blocked"],
  );
  assert.equal(presentations.idle.cartSelectionDisabled, false);
  assert.equal(presentations.loading.busy, true);
  assert.equal(presentations.ready.playDisabled, false);
  assert.equal(presentations.running.pauseDisabled, false);
  assert.equal(presentations["audio-blocked"].playLabel, "Enable audio");
  assert.equal(presentations["audio-blocked"].pauseDisabled, false);
  assert.equal(presentations.paused.playLabel, "Resume");
  assert.equal(presentations.stopped.resetDisabled, false);
  assert.equal(presentations.faulted.resetDisabled, false);
  assert.equal(presentations.disposed.cartSelectionDisabled, true);
  assert.equal(presentations.disposed.fullscreenDisabled, true);
  assert.equal(presentations.disposed.muteDisabled, true);
  assert.equal(
    derivePlayerShellPresentation({
      state: "faulted",
      hasRetainedCart: false,
      muted: false,
    }).resetDisabled,
    true,
  );
});

test("local choose/drop preflight is single-file, suffix-bound and size-bound", () => {
  for (const name of ["cart.p8", "cart.P8", "cart.p8.png", "cart.P8.PNG"]) {
    assert.deepEqual(validateLocalCartSelection([{ name, size: 1 }]), { ok: true });
  }
  assert.match(validateLocalCartSelection([]).message, /exactly one/u);
  assert.match(
    validateLocalCartSelection([
      { name: "one.p8", size: 1 },
      { name: "two.p8", size: 1 },
    ]).message,
    /exactly one/u,
  );
  assert.match(validateLocalCartSelection([{ name: "cart.png", size: 1 }]).message, /.p8/u);
  assert.match(validateLocalCartSelection([{ name: "cart.p8", size: 0 }]).message, /empty/u);
  assert.match(
    validateLocalCartSelection([{ name: "cart.p8", size: MAX_LOCAL_CART_BYTES + 1 }])
      .message,
    new RegExp(String(MAX_LOCAL_CART_BYTES), "u"),
  );
});

test("integer scaling never stretches the 128x128 backing surface", () => {
  assert.equal(computeIntegerScale(1, 1), 1);
  assert.equal(computeIntegerScale(255.9, 900), 1);
  assert.equal(computeIntegerScale(256, 900), 2);
  assert.equal(computeIntegerScale(800, 500), 3);
  assert.equal(computeIntegerScale(10_000, 10_000), 8);
  assert.equal(computeIntegerScale(10_000, 10_000, 4), 4);
  assert.throws(() => computeIntegerScale(0, 128), /positive/u);
  assert.throws(() => computeIntegerScale(128, Number.NaN), /positive/u);
});

test("the default shell is class-driven DOM with reduced-motion and accessibility hooks", async () => {
  const [main, view, stylesheet] = await Promise.all([
    readFile("apps/web-player/src/main/main.ts", "utf8"),
    readFile("apps/web-player/src/main/ui/player-shell-view.ts", "utf8"),
    readFile("apps/web-player/public/player.css", "utf8"),
  ]);
  assert.doesNotMatch(main, /\.style\./u);
  assert.doesNotMatch(view, /\.style\./u);
  assert.match(view, /role", "status/u);
  assert.match(view, /role", "alert/u);
  assert.match(view, /aria-pressed/u);
  assert.match(view, /PICO-8 playfield/u);
  assert.match(stylesheet, /prefers-reduced-motion: reduce/u);
  assert.match(stylesheet, /min-block-size: 2\.75rem/u);
  assert.match(stylesheet, /image-rendering: pixelated/u);
  assert.match(stylesheet, /data-scale="8"/u);
});
