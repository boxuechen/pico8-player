# ADR-011：后台与失焦时暂停，不追赶墙钟 backlog

- 状态：Accepted
- 日期：2026-08-06
- 决策范围：Chrome/Chromium player lifecycle 与 FrameScheduler anchor

## Context

浏览器在 hidden tab 中会节流 rAF；窗口失焦也可能留下无法收到 `keyup` 的 held input。若把
恢复后的 wall-clock delta 直接交给 simulation，会造成大批 catch-up tick、输入卡住和与设备
性能相关的行为。AudioWorklet queue 也不能反向决定游戏是否追帧。

## Decision

- main `PlayerController` 在 `visibilityState=hidden` 或 Window blur 时清零 normalized input，
  发送显式 pause，并取消 rAF；可选 AudioContext 同步 suspend。
- 页面重新 visible/focus 后，只在本次 pause 确由 environment 触发时显式 resume。
- Worker `FrameScheduler.pause/resume` 清空 accumulator 和 anchor；恢复后的首个 rAF pulse 只建立
  新 anchor，不补跑后台经过的时间。
- 用户主动 pause 不因 Window focus/visibility event 自动恢复。单个前台 pulse 的 catch-up 仍受
  Phase 1E 的 5-tick cap 约束。

## Consequences

后台经过的 simulation time 被有意丢弃；这符合当前 player 的确定性和资源上限目标，但不是对
官方所有后台运行模式的兼容声明。未来若需要 background play，必须新增独立 mode、兼容测试和
资源预算，不得静默修改默认策略。

## Verification

- `tests/runtime/phase-1e-scheduler-player.test.mjs`：pause/resume re-anchor 与 backlog drop。
- `tests/browser/phase-1e.mjs`：blur 清 held、暂停 frame、focus 后从新 anchor 恢复。
- `pnpm run test:phase-1e`。
