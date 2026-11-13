import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PlayerInputFrontend } from "../../apps/player/dist/main/player-input.js";

class FakeDocument extends EventTarget {
  activeElement;
  visibilityState = "visible";
}

class FakeElement extends EventTarget {
  dataset = {};
  children = [];
  querySelectorAll() { return this.children; }
}

function input(controllers, overrides = {}) {
  return {
    controllers: [...controllers, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8),
    devkit: {
      mouseXRaw: 0,
      mouseYRaw: 0,
      mouseButtons: 0,
      wheelRaw: 0,
      movementXRaw: 0,
      movementYRaw: 0,
      keypresses: [],
      ...overrides,
    },
  };
}

test("host input is copy-owned, merged and transient devkit data is consumed once", () => {
  const fakeWindow = new EventTarget();
  const document = new FakeDocument();
  const focus = new FakeElement();
  document.activeElement = focus;
  const frontend = new PlayerInputFrontend(focus, {
    window: fakeWindow,
    document,
    gamepadSource: { getGamepads: () => [] },
  });
  frontend.setEnabled(true);

  const source = input([0x11, 0x20], { wheelRaw: 3, keypresses: [97] });
  frontend.setHostInput(source);
  source.controllers[0] = 0;
  source.devkit.keypresses[0] = 0;

  assert.deepEqual(frontend.takeSnapshot().controllers.slice(0, 2), [0x11, 0x20]);
  assert.deepEqual(frontend.takeSnapshot().devkit.keypresses, []);
  assert.equal(frontend.takeSnapshot().devkit.wheelRaw, 0);
  frontend.setEnabled(false);
  frontend.setEnabled(true);
  assert.deepEqual(frontend.snapshot().controllers, new Array(8).fill(0));
  frontend.setHostInput(input([1]));
  frontend.clear();
  assert.deepEqual(frontend.snapshot().controllers, new Array(8).fill(0));
  frontend.dispose();
});

test("host input rejects malformed snapshots", () => {
  const frontend = new PlayerInputFrontend(new FakeElement(), {
    window: new EventTarget(),
    document: new FakeDocument(),
    gamepadSource: { getGamepads: () => [] },
  });
  assert.throws(() => frontend.setHostInput(input([64])), /fixed controller snapshot/u);
  assert.throws(() => frontend.setHostInput({ ...input([1]), controllers: [1] }),
    /fixed controller snapshot/u);
  frontend.dispose();
});

test("hosted shell is opt-in and hides app-owned chrome without inline style policy", async () => {
  const [view, stylesheet, embed] = await Promise.all([
    readFile("apps/player/src/main/ui/player-shell-view.ts", "utf8"),
    readFile("apps/player/public/player.css", "utf8"),
    readFile("apps/player/src/main/embed-player.ts", "utf8"),
  ]);
  assert.match(view, /options\.shell \?\? "full"/u);
  assert.match(stylesheet, /data-shell-mode="hosted"/u);
  assert.match(embed, /readonly shell\?: PlayerShellMode/u);
  assert.doesNotMatch(view, /\.style\./u);
});
