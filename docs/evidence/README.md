# Evidence archive

本目录保存已完成阶段和非 hermetic differential 的不可变证据。它用于审计、回归和
追溯，不属于每个实现任务的默认阅读集合。

- [`phase-0/`](./phase-0/)：Phase 0S–0F 完成记录。
- [`phase-1/`](./phase-1/)：Phase 1A–1F L1 bounded-profile 完成记录。
- [`phase-2/`](./phase-2/)：Phase 2A–2F Graphics/Memory/Text project-profile 完成记录。
- [`phase-3/`](./phase-3/)：Phase 3A–3H Audio/Input/Persistence project-profile 完成记录。
- [`phase-4/`](./phase-4/)：Phase 4A–4H L2/MVP project-profile 完成记录与 Known Differences。
- [`phase-5/`](./phase-5/)：Phase 5A–5H L3 local/multicart project-profile 完成记录、100-swap 与 Chrome long-run gate。
- [`phase-0e-official-clock.json`](./phase-0e-official-clock.json)：官方 Web Player
  startup-clock capture 的结构化记录。
- `phase-0e-*.png`：对应 capture 的人工审阅 framebuffer。

阶段完成后，执行文档可以归档到这里；Accepted decision 仍由 `docs/adr/` 拥有，机器
契约仍由 `spec/` 拥有。Evidence 不应复制回 active phase 文档。
