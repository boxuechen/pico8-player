# Phase 0S 完成证据

> 状态：Complete
> 日期：2026-08-05
> 范围：workspace scaffold、package/execution-domain boundaries、public exports、spec/WASM ownership 与机器门禁

本阶段只建立可执行边界，不包含 z8lua/WASM、cart parsing、Pico RAM、PICO-8 API、graphics/audio/input、Player UI 或 BBS 访问行为。

## 工具选择

| 工具 | 固定版本 | 用途 | 许可证/影响 |
| --- | --- | --- | --- |
| Node.js | `22.22.2`（`.node-version`） | ESM、内置 `node:test`、architecture runner | MIT + bundled third-party notices；测试 runner 不增加 npm dependency |
| pnpm | `10.8.0`（root `packageManager`、CI） | workspace 与 lockfile | MIT；只影响开发/CI |
| TypeScript | `7.0.2` | `tsc -b` composite build/typecheck 与 declarations | Apache-2.0；开发依赖 |
| `@babel/parser` | `8.0.4` | TypeScript import/global AST boundary analysis | MIT；只在 architecture tests 使用，不进入 player bundle |

TypeScript 7 compiler package 不提供旧版 JavaScript compiler AST surface，因此 build/typecheck 仍由 `tsc` 执行，边界 checker 使用独立 parser。未引入 dependency-cruiser 或 ESLint runtime；规则、rule ID 和 negative fixtures 全部保存在仓库中，可直接审查。

CI 使用 MIT 许可的 `actions/checkout@v5`、`pnpm/action-setup@v4` 和 `actions/setup-node@v5`，统一执行 `pnpm install --frozen-lockfile` 与 `pnpm run verify`。三个 actions 均只影响 CI，不进入产物；major tag 更新需通过相同 exit gate。

## 边界覆盖

`tests/architecture/architecture.test.mjs` 与 `tools/architecture/architecture.mjs` 机器验证：

- 四 package production manifest DAG 无环且只包含 ADR-015 允许边。
- package 只通过声明的 `exports` 访问；consumer project 与 Node ESM 可加载 public roots，internal subpath 被真实拒绝。
- z8lua bridge → RuntimeCore 只允许 type-only public edge，并检查 build output 不产生 RuntimeCore runtime load。
- contracts/cart-codec/runtime-core、transport、main、worker、worklet 使用独立 TypeScript lib surface。
- package → apps、main → RuntimeCore、worklet → z8lua、deep import、platform global 与 `ref/` import 均有 negative fixture。
- 人为 package cycle、非法 dependency、`ref/*` workspace glob 和未登记 generated source 均被 checker 拒绝。
- `spec/abi/generated-bindings.manifest.json` 是 generated binding hash allowlist；Phase 0S 的文件列表为空。
- main、worker、worklet entrypoint 与四个 package public root 均产生独立 build output。

## 可复现验证

在 Node `22.22.2`、pnpm `10.8.0` 环境执行：

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run typecheck
pnpm run test:public-exports
pnpm run test:architecture
pnpm run verify
```

最终结果：全部通过；architecture suite 为 **16/16 passed**。`pnpm run verify` 是本地与 CI 的统一 Phase 0S exit gate。

## Exit Gate 审计

- [x] 四个 packages 与 app execution domains 可独立 composite typecheck/build。
- [x] package exports、project references 和 production DAG 与 canonical 文档一致。
- [x] architecture positive audit 与所有 negative fixtures 通过。
- [x] main、worker、worklet 最小 entrypoint 可构建且没有隐式 mutable state。
- [x] Pico API inventory、ABI/generated manifest、WASM pin/bridge/patch/dist ownership 骨架存在。
- [x] `ref/` 被 Git 忽略且被 workspace/import/build gates 拒绝。
- [x] 文档只维护一份 canonical source layout；本页记录真实验证证据。

Phase 0S 到此停止。下一阶段必须作为独立 Goal 进入 Phase 0A，不得在本阶段提交中混入 WASM 或 cart behavior。
