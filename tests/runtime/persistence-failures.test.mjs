import assert from "node:assert/strict";
import test from "node:test";

import {
  IndexedDbCartDataPersistenceAdapter,
} from "../../apps/player/dist/runtime/adapters/indexeddb-persistence-adapter.js";

class FakeRequest extends EventTarget {
  result;
  error = null;
}

class FakeTransaction extends EventTarget {
  error = null;

  constructor(mode) {
    super();
    this.mode = mode;
  }

  objectStore() {
    if (this.mode === "readonly") {
      return {
        index: () => ({
          getAll: () => {
            const request = new FakeRequest();
            setTimeout(() => {
              request.result = [];
              request.dispatchEvent(new Event("success"));
              setTimeout(() => this.dispatchEvent(new Event("complete")), 0);
            }, 0);
            return request;
          },
        }),
      };
    }
    return {
      put: () => undefined,
    };
  }

  abortWith(error) {
    setTimeout(() => {
      this.error = error;
      this.dispatchEvent(new Event("abort"));
    }, 0);
  }
}

class FakeDatabase extends EventTarget {
  closed = false;
  failWrites = true;
  writes = [];

  transaction(_store, mode) {
    const transaction = new FakeTransaction(mode);
    if (mode === "readwrite") {
      if (this.failWrites) {
        transaction.abortWith(new DOMException("quota exhausted", "QuotaExceededError"));
      } else {
        transaction.objectStore = () => ({ put: (record) => this.writes.push(record) });
        setTimeout(() => transaction.dispatchEvent(new Event("complete")), 0);
      }
    }
    return transaction;
  }

  close() {
    this.closed = true;
  }
}

function failingFactory(mode) {
  return {
    open() {
      const request = new FakeRequest();
      setTimeout(() => {
        if (mode === "blocked") {
          request.dispatchEvent(new Event("blocked"));
        } else {
          request.error = new DOMException("storage denied", "NotAllowedError");
          request.dispatchEvent(new Event("error"));
        }
      }, 0);
      return request;
    },
  };
}

function databaseFactory(database) {
  return {
    open() {
      const request = new FakeRequest();
      setTimeout(() => {
        request.result = database;
        request.dispatchEvent(new Event("success"));
      }, 0);
      return request;
    },
  };
}

test("denied and blocked IndexedDB open are visible, bounded read diagnostics", async () => {
  for (const [mode, expectedCause] of [
    ["denied", "NotAllowedError: storage denied"],
    ["blocked", "Cartdata IndexedDB upgrade was blocked"],
  ]) {
    const adapter = new IndexedDbCartDataPersistenceAdapter({
      factory: failingFactory(mode),
      databaseName: `phase-7g-${mode}`,
      debounceMs: 60_000,
    });
    assert.deepEqual(await adapter.hydrate(), []);
    const diagnostics = adapter.takeDiagnostics();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "E_PERSISTENCE_READ");
    assert.equal(diagnostics[0].recoverable, true);
    assert.equal(diagnostics[0].details.cause, expectedCause);
    await adapter.dispose();
  }
});

test("quota abort preserves the copy-owned pending snapshot", async () => {
  const database = new FakeDatabase();
  const adapter = new IndexedDbCartDataPersistenceAdapter({
    factory: databaseFactory(database),
    databaseName: "phase-7g-quota",
    debounceMs: 60_000,
  });
  assert.deepEqual(await adapter.hydrate(), []);
  const bytes = new Uint8Array(256).fill(0x5a);
  adapter.enqueue({ id: "release", bytes });
  bytes.fill(0);
  const failed = await adapter.flush();
  assert.equal(failed.durable, false);
  const diagnostics = adapter.takeDiagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "E_PERSISTENCE_WRITE");
  assert.equal(diagnostics[0].recoverable, true);
  assert.equal(
    diagnostics[0].details.cause,
    "QuotaExceededError: quota exhausted",
  );
  const hydrated = await adapter.hydrate();
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].id, "release");
  assert.deepEqual(hydrated[0].bytes, new Uint8Array(256).fill(0x5a));
  database.failWrites = false;
  assert.deepEqual(await adapter.flush(), { durable: true });
  assert.deepEqual(new Uint8Array(database.writes[0].bytes), new Uint8Array(256).fill(0x5a));
  await adapter.dispose();
  assert.equal(database.closed, true);
});
