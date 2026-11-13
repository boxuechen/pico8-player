# Documentation

Start with the [project README](../README.md) or [中文首页](../README.zh-CN.md). The guides below describe the current implementation; completed plans and historical reports remain in Git history.

| Goal | English | 简体中文 |
| --- | --- | --- |
| Embed real-time playback, input and saves | [Browser player](player.md) | [浏览器接入](player.zh-CN.md) |
| Load source, step frames and integrate tools | [Standalone sessions](standalone-session.md) | [独立会话](standalone-session.zh-CN.md) |
| Understand execution, ownership and lifecycle | [Architecture](architecture.md) | [架构](architecture.zh-CN.md) |
| Build, test and publish static assets | [Development](development.md) | [开发与验证](development.zh-CN.md) |
| Check supported behavior and known differences | [Compatibility](compatibility.md) | [兼容范围](compatibility.zh-CN.md) |

## Reference

- [Public TypeScript exports](../apps/player/src/main/public.ts)
- [PICO-8 API inventory](../spec/pico-api-inventory.yaml)
- [Release artifact contract](../spec/release-artifact-contract.json)
- [WASM source, toolchain and ABI](../wasm/README.md)
- [Changelog](../CHANGELOG.md), [contributing](../CONTRIBUTING.md) and [third-party notices](../THIRD_PARTY_NOTICES.md)

Source and behavioral tests define what is implemented. Machine-readable contracts in `spec/` define the ABI, artifact format and compatibility inventory. A historical design goal is not a current capability claim.
