import { PlayerLifecycleQueue } from "../../../apps/player/dist/runtime/lifecycle-queue.js";

/** Gives facade-only doubles the same admission/teardown contract as PlayerController. */
export function withControllerLifecycle(controller) {
  const queue = new PlayerLifecycleQueue();
  controller.teardown = controller.dispose.bind(controller);
  controller.runLifecycle = operation => queue.run(() => operation(controller));
  controller.dispose = (hooks = {}) => queue.close(async () => {
    try { await hooks.beforeDispose?.(controller); }
    finally {
      try { await controller.teardown(); }
      finally { await hooks.afterDispose?.(); }
    }
  });
  return controller;
}
