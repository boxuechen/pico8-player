import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decodeCart } from "@pico8-player/cart-codec";
import {
  PICO_CART_INPUT_MAX_BYTES,
  PICO_CART_REF_MAX_BYTES,
  PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES,
} from "@pico8-player/contracts";
import {
  CART_RESOLUTION_ERROR_CODES,
  CartCancellationSource,
  CartLoader,
} from "@pico8-player/runtime-core";
import {
  CartRepositoryAdapter,
  CURRENT_CART_REPOSITORY_MAX_CARTS,
} from "../../apps/player/dist/runtime/adapters/cart-repository-adapter.js";
import {
  LocalCartBundleResolver,
} from "../../apps/player/dist/runtime/adapters/host-cart-resolver-adapter.js";

const ALLOW_ALL = Object.freeze({
  load: true,
  reloadData: true,
  cstoreData: true,
  include: true,
});

const LOAD_ONLY = Object.freeze({
  load: true,
  reloadData: false,
  cstoreData: false,
  include: false,
});

const NEVER_CANCELLED = Object.freeze({
  cancelled: false,
  onCancel() {
    return () => undefined;
  },
});

async function validCartBytes() {
  return new Uint8Array(await readFile(new URL(
    "../fixtures/multicart/chapter-b.p8",
    import.meta.url,
  )));
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function cartWithIdentity(cart, contentSha256) {
  return {
    ...cart,
    identity: Object.freeze({ contentSha256 }),
    rom: cart.rom.slice(),
    code: cart.code.slice(),
    luaSource: cart.code.slice(),
  };
}

test("public L3 limits and runtime-neutral cancellation are bounded", () => {
  assert.equal(PICO_CART_INPUT_MAX_BYTES, 1_048_576);
  assert.equal(PICO_CART_REF_MAX_BYTES, 256);
  assert.equal(PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES, 64);
  assert.equal(CURRENT_CART_REPOSITORY_MAX_CARTS, 64);

  const source = new CartCancellationSource();
  let subscribed = 0;
  let removed = 0;
  source.token.onCancel(() => {
    subscribed += 1;
  });
  const unsubscribe = source.token.onCancel(() => {
    removed += 1;
  });
  unsubscribe();
  source.cancel();
  source.cancel();
  assert.equal(source.token.cancelled, true);
  assert.equal(subscribed, 1);
  assert.equal(removed, 0);

  let late = 0;
  source.token.onCancel(() => {
    late += 1;
  });
  assert.equal(late, 1);
  assert.equal("signal" in source.token, false);
});

test("local bundle resolver owns bytes/capabilities and checks purpose twice", async () => {
  const bytes = await validCartBytes();
  const mutableAccess = { ...ALLOW_ALL };
  const resolver = new LocalCartBundleResolver([
    { ref: "chapter-b.p8", bytes, access: mutableAccess },
  ]);
  bytes.fill(0);
  mutableAccess.load = false;

  const first = await resolver.resolve(
    "chapter-b.p8",
    { purpose: "load" },
    NEVER_CANCELLED,
  );
  assert.equal(first.bytes[0], "p".charCodeAt(0));
  assert.equal(first.access.load, true);
  assert.equal(Object.isFrozen(first.access), true);
  first.bytes.fill(0);
  const second = await resolver.resolve(
    "chapter-b.p8",
    { purpose: "include" },
    NEVER_CANCELLED,
  );
  assert.equal(second.bytes[0], "p".charCodeAt(0));

  const denied = new LocalCartBundleResolver([
    { ref: "looks-powerful.p8", bytes: await validCartBytes(), access: LOAD_ONLY },
  ]);
  await assert.rejects(
    async () => denied.resolve("looks-powerful.p8", { purpose: "reload" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.accessDenied),
  );
  await assert.rejects(
    async () => denied.resolve("looks-powerful.p8", { purpose: "cstore" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.accessDenied),
  );
  await assert.rejects(
    async () => denied.resolve("looks-powerful.p8", { purpose: "include" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.accessDenied),
  );
  await assert.rejects(
    async () => denied.resolve("looks-powerful.p8", { purpose: "unknown" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.accessDenied),
  );
});

test("codec-time include lookup is synchronous, copied and capability checked", () => {
  const resolver = new LocalCartBundleResolver([{
    ref: "shared.lua",
    bytes: Uint8Array.of(1, 2, 3),
    access: { load: false, reloadData: false, cstoreData: false, include: true },
  }]);
  const first = resolver.resolveImmediate("shared.lua", "include");
  first.bytes[0] = 99;
  assert.deepEqual(resolver.resolveImmediate("shared.lua", "include").bytes, Uint8Array.of(1, 2, 3));

  const denied = new LocalCartBundleResolver([{
    ref: "private.lua",
    bytes: Uint8Array.of(1),
    access: { load: true, reloadData: false, cstoreData: false, include: false },
  }]);
  assert.throws(
    () => denied.resolveImmediate("private.lua", "include"),
    expectCode(CART_RESOLUTION_ERROR_CODES.accessDenied),
  );
});

test("local bundle resolver rejects invalid refs, duplicates, limits and missing entries", async () => {
  const bytes = await validCartBytes();
  assert.throws(
    () => new LocalCartBundleResolver([
      { ref: "same.p8", bytes, access: ALLOW_ALL },
      { ref: "same.p8", bytes, access: ALLOW_ALL },
    ]),
    expectCode(CART_RESOLUTION_ERROR_CODES.duplicateRef),
  );
  assert.throws(
    () => new LocalCartBundleResolver(Array.from(
      { length: PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES + 1 },
      (_, index) => ({ ref: `${index}.p8`, bytes, access: ALLOW_ALL }),
    )),
    expectCode(CART_RESOLUTION_ERROR_CODES.bundleLimit),
  );
  assert.throws(
    () => new LocalCartBundleResolver([
      { ref: "too-big.p8", bytes: new Uint8Array(PICO_CART_INPUT_MAX_BYTES + 1), access: ALLOW_ALL },
    ]),
    expectCode(CART_RESOLUTION_ERROR_CODES.sourceTooLarge),
  );
  for (const ref of ["", "/absolute.p8", "../escape.p8", "dir//cart.p8", "#123", "https://example.test/cart.p8", "界".repeat(86)]) {
    assert.throws(
      () => new LocalCartBundleResolver([{ ref, bytes, access: ALLOW_ALL }]),
      expectCode(CART_RESOLUTION_ERROR_CODES.invalidRef),
      ref,
    );
  }

  const resolver = new LocalCartBundleResolver([{ ref: "known.p8", bytes, access: ALLOW_ALL }]);
  await assert.rejects(
    async () => resolver.resolve("missing.p8", { purpose: "load" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.notFound),
  );
});

test("local bundle cancellation and disposal fail closed", async () => {
  const bytes = await validCartBytes();
  const cancelled = new CartCancellationSource();
  cancelled.cancel();
  const resolver = new LocalCartBundleResolver([{ ref: "cart.p8", bytes, access: ALLOW_ALL }]);
  await assert.rejects(
    resolver.resolve("cart.p8", { purpose: "load" }, cancelled.token),
    expectCode(CART_RESOLUTION_ERROR_CODES.cancelled),
  );

  const pending = resolver.resolve("cart.p8", { purpose: "load" }, NEVER_CANCELLED);
  resolver.dispose();
  await assert.rejects(pending, expectCode(CART_RESOLUTION_ERROR_CODES.disposed));
  await assert.rejects(
    async () => resolver.resolve("cart.p8", { purpose: "load" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.disposed),
  );
});

test("CartLoader rejects stale completion and only commits validated decoded carts", async () => {
  const bytes = await validCartBytes();
  const repository = new CartRepositoryAdapter();
  let complete;
  const maliciousResolver = {
    resolve() {
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const loader = new CartLoader(maliciousResolver, repository);
  const cancellation = new CartCancellationSource();
  const pending = loader.load("late.p8", { purpose: "load" }, cancellation.token);
  cancellation.cancel();
  complete({ ref: "late.p8", bytes, access: ALLOW_ALL });
  await assert.rejects(pending, expectCode(CART_RESOLUTION_ERROR_CODES.cancelled));

  const parsed = decodeCart(bytes);
  assert.equal(repository.get(parsed.identity), undefined);

  const resolver = new LocalCartBundleResolver([
    { ref: "chapter-b.p8", bytes, access: LOAD_ONLY },
  ]);
  const loaded = await new CartLoader(resolver, repository).load(
    "chapter-b.p8",
    { purpose: "load" },
    NEVER_CANCELLED,
  );
  assert.equal(loaded.cart.identity.contentSha256, parsed.identity.contentSha256);
  assert.equal(Object.isFrozen(loaded.access), true);
  loaded.cart.rom[0] ^= 0xff;
  assert.notEqual(repository.get(parsed.identity).rom[0], loaded.cart.rom[0]);

  const mismatched = new CartLoader({
    async resolve() {
      return { ref: "other.p8", bytes, access: ALLOW_ALL };
    },
  }, repository);
  await assert.rejects(
    mismatched.load("requested.p8", { purpose: "load" }, NEVER_CANCELLED),
    expectCode(CART_RESOLUTION_ERROR_CODES.invalidRef),
  );
});

test("repository caches parsed carts by identity and preserves protected COW isolation", async () => {
  const parsed = decodeCart(await validCartBytes());
  const repository = new CartRepositoryAdapter();
  repository.put(parsed);

  parsed.rom[12] = 0xff;
  parsed.code[0] = 0xff;
  const first = repository.get(parsed.identity);
  assert.notEqual(first.rom[12], 0xff);
  assert.notEqual(first.code[0], 0xff);
  first.rom[12] = 0xee;
  assert.notEqual(repository.get(parsed.identity).rom[12], 0xee);

  const overlay = Uint8Array.of(0x91, 0x92);
  repository.writeDataOverlay(parsed.identity, 12, overlay);
  overlay.fill(0);
  const read = repository.readData(parsed.identity, 12, 2);
  assert.deepEqual(read, Uint8Array.of(0x91, 0x92));
  read.fill(0);
  assert.deepEqual(repository.readData(parsed.identity, 12, 2), Uint8Array.of(0x91, 0x92));

  const original = repository.get(parsed.identity);
  const codeConflict = { ...original, code: original.code.slice(), luaSource: original.code.slice() };
  codeConflict.code[0] ^= 0xff;
  assert.throws(() => repository.put(codeConflict), /different parsed cart content/u);
  const romConflict = { ...original, rom: original.rom.slice() };
  romConflict.rom[0x5000] ^= 0xff;
  assert.throws(() => repository.put(romConflict), /different ROM bytes/u);

  for (let index = 1; index < CURRENT_CART_REPOSITORY_MAX_CARTS; index += 1) {
    repository.put(cartWithIdentity(
      original,
      index.toString(16).padStart(64, "0"),
    ));
  }
  assert.throws(() => repository.put(cartWithIdentity(original, "f".repeat(64))), /64-cart/u);
  repository.dispose();
  assert.throws(() => repository.get(parsed.identity), /disposed/u);
});

test("local resolver production source contains no discovery or I/O primitive", async () => {
  const source = await readFile(new URL(
    "../../apps/player/src/runtime/adapters/host-cart-resolver-adapter.ts",
    import.meta.url,
  ), "utf8");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "FileReader", "importScripts(", "indexedDB"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
