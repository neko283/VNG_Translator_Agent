# LinguaGacha Agent

在 coding agent 中翻译 TXT、KV-JSON、Message-JSON，使用原 `.lg` 工程、Item 和格式写回规则，并保存术语、批次回执及审校进度。翻译模型由当前宿主提供，无需安装 LinguaGacha 桌面应用或另配模型 API。

## 本地运行

先激活已安装的 **Node.js >=24.22.1**。项目不下载 Node，不依赖原 LinguaGacha 源码目录。

```sh
node --version
npm ci
npm run build
node bin/lg-agent.mjs doctor
```

首次下载后必须完成上述安装和构建。之后在本目录启动 coding agent，读取 [共享翻译技能](skills/linguagacha/SKILL.md)，例如：

> 使用 linguagacha，把用户指定工作目录里的文本翻译成简体中文，先整理术语，完成审校后导出到该工作目录。

或者：

> 继续用户指定工作目录下 book.lg 中的任务，沿用已保存的术语和进度。

项目内提供 `.agents/skills/linguagacha/` 和 `.claude/skills/linguagacha/` 入口，共用一份技能正文。若宿主没有发现入口，可以显式让它读取上面的共享技能。无需把技能复制到用户全局目录。

## 实现内容

- 原三种格式适配器、Item 及原工程迁移与局部写入规则。
- SQLite + zstd 的 `.lg` 资产；旧工程原始资产、未知字段和其他格式内容保持存储。
- 原术语、保护、替换、预过滤、重复文本和质量检查逻辑。
- 术语调查检查点、分批翻译、语义审校记录、事务回执及跨会话恢复。
- 独立 CLI；构建和运行只使用本目录内的源码、资源及依赖。

[CLI 协议和示例](docs/CLI.md) · [实现与验证边界](docs/IMPLEMENTATION.md) · [方案副本](docs/PLAN_V2.md) · [源码来源及改动](docs/UPSTREAM.md)

## 验证

```sh
npm run verify
```

测试覆盖原格式行为、部分提交、实际子进程中断、重复提交、并发进程、术语变化、审校失效、迁移备份、输出校验，以及不带上游源码的便携构建运行。

原应用 GUI 的实际打开/保存往返，以及 Claude Code 中真实模型会话的端到端演练仍需实机验证；当前已验证复制的原数据库访问/迁移模块往返及 CLI 跨进程恢复。详细结果见实现说明。
