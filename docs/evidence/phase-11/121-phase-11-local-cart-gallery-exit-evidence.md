# Phase 11 — Local Cart Gallery 完成证据

> 状态：Complete
>
> 产品边界：与 `0.1.0-rc.1` release artifact 隔离的 loopback-only developer tool
>
> 第三方内容：tracked bytes / screenshots / per-cart results 均为 0

## 完成结论

Phase 11A 已完成。`tools/local-gallery/` 从调用者显式授权的 read-only directory 建立 process-local
opaque catalog，只绑定 `127.0.0.1`；浏览器 gallery 通过原有 release manifest 加载 embed API，并把
选中的 local bytes 交给 `loadCart` / `start`。Runtime、WASM、公开 API 和 release 文件均未修改。

## Bounded verification

| Gate | 结果 |
| --- | --- |
| Activation contract | 2/2 |
| Loopback server contract | 3/3 |
| Focused Chrome | 1 run；2 project-owned carts |
| Chrome behaviors | catalog、search、first frame、cart swap、desktop resize、reduced motion、teardown 全部通过 |
| Visual review | 1365×900 临时截图检查通过；截图未进入仓库 |
| Release verifier | 15 files、6 stable artifact keys |
| Release archive | SHA-256 `674b7a1ba872f5171cb3e04764a1299495805d6d2cc67a474cb00049bba0115c`，与 Phase 10 相同 |
| Historical exit maintenance | Phase 10 不再把“最近完成永远是 Phase 10”作为永久断言；其 closure 断言保持 |
| External corpus automated runs | 0 |
| Historical matrix / long soak | 0 / 0 |

Chrome gate 使用 `Google Chrome 151.0.7922.76`。自动化仅在系统临时目录创建两个本项目拥有的 text
cart；没有读取 local corpus、`ref/`、第三方 inventory 或逐卡结果。人工体验目录只作为最终 CLI
启动参数，不成为 build/test/release input。

## Handoff

```sh
pnpm run build:release
node tools/local-gallery/server.mjs --cart-root /absolute/path/to/carts
```

服务端只接受显式 cart root 和可选 port，不提供 non-loopback bind、远程 fetch、上传、目录写入或
任意文件 route。catalog 只暴露进程内 ID、相对 display metadata、format/size 和受控 cart/thumbnail
route；绝对路径不会传给浏览器。
