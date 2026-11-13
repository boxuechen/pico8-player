# Web Player 接入

从完整 release 的 `main/player.mjs` 导入；同时加载 `player.css`。WASM、Worker、Worklet 保持发布目录中的相对位置。浏览器以 HTTP 服务提供文件；CSP/MIME 和文件列表见 `spec/release-artifact-contract.json`。

```js
import { createPico8Player } from "./main/player.mjs";
const player = await createPico8Player({
  root: document.querySelector("#player"),
  // execution: "worker", // 可选；默认主线程
  // shell: "hosted",     // 宿主管理选卡与控制按钮
});
const unsubscribe = player.on("fault", ({ error }) => console.error(error));
try {
  await player.loadCart(cartBytes, { displayName: "my-game.p8" });
  await player.start(); // 当前 generation 的首帧已实际绘制到 Canvas
} catch (error) {
  console.error(error);
}
// 退出宿主页面/组件时：
// unsubscribe(); await player.dispose();
```

`loadCart` 接受调用方拥有的 Uint8Array；`localCartBundle` 显式授予每个 ref 的 load/reloadData/cstoreData/include 权限。没有任意 URL loader。

API v2：`loadCart/start/pause/resume/reset/stop/flushPersistence/handleLifecycle/dispose` 返回 Promise；`setInput` 更新八玩家/devkit 输入。`state/root/canvas` 为只读属性；`on(type, listener)` 返回取消订阅函数，事件类型为 `state/frame/diagnostic/fault/persistence`。frame 包含 copy-owned packedScreen/displayPalette、frameId、generation 和 CPU 统计。

API、UI 和环境事件共用生命周期队列。`start()` 可能因 fault、取消或首帧超时而拒绝；这与单纯收到 running 状态不同。`handleLifecycle("inactive" | "background" | "active")` 用于宿主生命周期。`dispose` 后不再发送公共事件，资源与必要存档提交会完成清理。

浏览器音频仍受用户手势限制；Web shell 在可信手势中启动音频。不要用 manual session 代替实时声音播放。

## 存档

默认 Web 路径使用 IndexedDB。宿主可通过 create options 提供：

```ts
interface HostPersistence {
  hydrate(contentId: string): Promise<readonly { id: string; bytes: Uint8Array }[]>;
  write(contentId: string, commit: { id: string; bytes: Uint8Array; revision: number }): Promise<void>;
  flush(contentId: string): Promise<void>;
}
```

此时每次 `loadCart` 必须提供稳定 `contentId`（1–128 字符，`[a-z0-9][a-z0-9:._-]*`）。每条 cartdata 为 256 bytes，id 使用 1–64 个 `[a-z0-9_-]` 字符。宿主必须使失败写入可在后续 flush 重试。

换卡先停止并 flush 旧身份，再 hydrate 新身份；失败不会误写新身份。`flushPersistence(reason?)` 返回 `status/reason/durable`，失败还可含 message；不能仅凭 `saved` 事件假定底层 durable。disposal 会等待必要的最终提交。

需要不挂载 UI 的 Lua→执行→观察循环，使用 [独立会话](standalone-session.md)。精确 TypeScript 类型由 `apps/player/src/main/public.ts` 导出。
