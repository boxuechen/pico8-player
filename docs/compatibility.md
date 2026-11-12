# 兼容范围

目标是 PICO-8 v0.2.7 cart runtime，接受 `.p8`、`.p8.png` 和独立会话 Lua 源码。浏览器支持 Chrome/Chromium；Node 仅提供无设备 session/tool 使用路径。不包含编辑器、SPLORE、系统控制台和导出工具。

[API inventory](../spec/pico-api-inventory.yaml) 逐项记录实现状态与兼容范围，行为向量在 `tests/runtime` 和 `tests/fixtures`。兼容标签描述受测试的 profile，不等于所有官方 cart 都可以逐位复现；旧外部 corpus 的通过率不作为当前默认主线程的性能承诺。

| 差异 | 当前行为 |
| --- | --- |
| 主线程执行 | 有 VM instruction cap；没有抢占式墙钟 watchdog，长同步 WASM 调用会占用 UI 线程 |
| `stat` | 支持的 deterministic selectors 返回对应类型；其他 selector 返回 false |
| timed P8SCII | delay 控制不挂起 guest；文本时间由逻辑帧推进 |
| fractional power | z8lua 浮点路径不承诺 official bit-exact |
| screen/bitplane | 支持 standard packed 4bpp；高级模式超出当前范围 |
| guest nested coroutine | `flip/run/stop/load`、外部 `reload/cstore` 和 HostRequest 仅 root 可恢复；nested suspension 拒绝且无外部副作用 |
| nested custom loop | CPU 持续计数，frame commit 等待 root 返回；永不返回时达到 hard cap |
| 观察与调试 | 提供画面和结构化 diagnostics；没有 `printh` stdout 捕获、断点或 live eval |

`flip`、`printh`、`stat`、`print`、`extcmd` 存在部分支持模式；`save/folder/ls/resume/reboot/info/serial` 属于未支持的 console/平台能力。精确模式以 inventory 和当前实现为准。

仅执行 caller-provided/caller-authorized bytes。没有自动访问 BBS、任意 URL cart loader 或宿主文件系统。WASM/字体来源及许可分别保存在 [WASM notices](../wasm/THIRD_PARTY_NOTICES.md) 和 [RuntimeCore notices](../packages/runtime-core/THIRD_PARTY_NOTICES.md)。
