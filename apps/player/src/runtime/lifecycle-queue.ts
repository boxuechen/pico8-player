/** One admitted lifecycle transaction at a time; frame/input delivery stays outside. */
export class PlayerLifecycleQueue {
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #disposal: Promise<void> | undefined;

  get closed(): boolean { return this.#closed; }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Player lifecycle is disposed"));
    const result = this.#tail.then(async () => {
      if (this.#closed) throw new Error("Player lifecycle is disposed");
      return operation();
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Close admission immediately; skip queued work and drain before teardown. */
  close(teardown: () => Promise<void>): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#closed = true;
    this.#disposal = this.#tail.then(teardown);
    return this.#disposal;
  }
}
