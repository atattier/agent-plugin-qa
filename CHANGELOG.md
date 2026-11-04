# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-11-05

- 首版：9 项检查（清单一致性 / override 可达 / lockfile 覆盖 / node_modules 对账 / 残留盘点 / 版本可解析性 / 分源连通性 / 补丁断言 / .npmrc 体格）
- `why` 诊断命令：对单个 `pkg@spec` 逐源列出可用版本并给出失败归类（对应缺陷单 BUG-01「报错应附加已查询的源与各源可用版本」的落地）
- 断言目录契约（`qa.asserts/*.mjs`）：把「补丁在位」类行为断言固化为可重跑脚本（对应 BUG-05 的应对机制泛化）
- 终端 / JSON 双输出，`--offline` 离线模式，退出码 0/1/2
