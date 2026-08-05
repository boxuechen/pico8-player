# Evidence archive

本目录保存已完成阶段和非 hermetic differential 的不可变证据。它用于审计、回归和
追溯，不属于每个实现任务的默认阅读集合。

- [`phase-0/`](./phase-0/)：Phase 0S–0F 完成记录。
- [`phase-1/`](./phase-1/)：Phase 1A–1F L1 bounded-profile 完成记录。
- [`phase-2/`](./phase-2/)：Phase 2A–2F Graphics/Memory/Text project-profile 完成记录。
- [`phase-0e-official-clock.json`](./phase-0e-official-clock.json)：官方 Web Player
  startup-clock capture 的结构化记录。
- `phase-0e-*.png`：对应 capture 的人工审阅 framebuffer。

阶段完成后，执行文档可以归档到这里；Accepted decision 仍由 `docs/adr/` 拥有，机器
契约仍由 `spec/` 拥有。Evidence 不应复制回 active phase 文档。
