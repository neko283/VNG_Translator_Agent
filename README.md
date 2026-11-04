# VNG Translator Agent

供 Codex、Claude Code 等 coding agent 使用的视觉小说翻译工具包。宿主模型完成翻译，`LinguaGacha_Agent` 管理术语、工程、审校和导出，`Game_Engine_Tools` 提供引擎解包、封包工具，`Translation_Workflow` 组织完整翻译与补丁制作流程。

整个目录可独立下载、移动和使用，不需要 LinguaGacha 桌面端或相邻源码目录。包内包含所需源码、内置规则、锁定依赖清单、技能、测试和文档，不附带历史游戏资源、译文、工程、字体或补丁。

## LinguaGacha 来源与改动

本项目的文本翻译模块基于 **[neavo/LinguaGacha](https://github.com/neavo/LinguaGacha)** 的部分源码与内置规则改造，感谢原作者 neavo 及贡献者。LinguaGacha 原工具是支持多种文本格式的桌面 AI 翻译器；本项目是面向 coding agent 的独立改造与整合。

- 原项目：[GitHub 仓库](https://github.com/neavo/LinguaGacha) · [官方使用文档](https://github.com/neavo/LinguaGacha/wiki) · [原工具下载](https://github.com/neavo/LinguaGacha/releases)。
- 本地复制基线：[b7b18772d52d2af40acb73c905179c9703749e3e](https://github.com/neavo/LinguaGacha/commit/b7b18772d52d2af40acb73c905179c9703749e3e)，不等同于上游当前最新版。
- 文件级来源和改动见 [UPSTREAM.md](LinguaGacha_Agent/docs/UPSTREAM.md)，保留文件的原始摘要见 [源码哈希清单](LinguaGacha_Agent/docs/upstream-hashes.json)。

| 部分 | 本项目的保留与改动 |
| --- | --- |
| 文本与工程核心 | 复用 TXT、KV-JSON、Message-JSON 适配器、Item 模型、`.lg` 数据库访问与迁移，以及术语、保护和文本处理逻辑；保留所需源码与规则资源 |
| 运行方式 | 从桌面应用中抽取所需能力，解除 Electron、GUI 和桌面模型 SDK 的相关装配依赖，提供独立 Node.js CLI；翻译和语义审校由当前宿主 agent 完成 |
| 任务与恢复 | 新增批次任务协议、提交回执、术语调查进度、审校记录和跨会话恢复；调整工程写入与事务边界 |
| 功能范围 | 当前只接入上述三种文本格式，未移植原工具的全部格式、GUI 或引擎集成功能；移除 PDF 写入执行分支 |
| 游戏工作流 | 另外整合 `Game_Engine_Tools` 的资源工具和 `Translation_Workflow` 的实施流程；这些整合不属于上游官方功能声明 |


## 安装与检查

需要已安装的 **Node.js >=24.22.1（含 npm）** 和 **Python >=3.9**。Ruby 仅供可选 PF8 独立复核器使用。首次安装 npm 依赖需要访问包仓库；不需要另配翻译模型 API。

在本目录运行：

```sh
node --version
python3 --version
npm run setup
npm run doctor
npm run verify
```

Windows 可将 `python3` 换为 `python`；验证脚本可通过环境变量 `PYTHON` 指定解释器。`setup` 按模块锁文件安装依赖并从包内源码构建。下载源码后必须先完成此步骤，不能直接使用尚未生成的 `dist`。

## 在 coding agent 中开始

在本目录启动 agent，读取 [AGENTS.md](AGENTS.md)。Claude Code 可从 [CLAUDE.md](CLAUDE.md) 进入。示例指令：

> 阅读 AGENTS.md。游戏在“我的游戏绝对路径”，所有实施记录、中间数据和最终补丁保存到“我的工作目录绝对路径”。先识别引擎，只翻译对白和旁白，选项框、设置、菜单和图片文字保留原文。先制作开头到首个选项前的测试补丁，等我确认字体和格式后再进行全量翻译。

工具目录与游戏目录、工作目录分开。`.lg`、解包资源、映射、术语资料、回执、字体和补丁均保存到用户指定工作根目录下的 `release/<game_id>/`；一个 `release` 可分别管理多个游戏。缺少工作根目录时先确认后再创建游戏产物。空白模板位于 [game_templates](Translation_Workflow/release/game_templates/README.md)，目录使用英文，文档文件名保留中文。

## 工作流程与能力边界

完整实施入口见 [Translation_Workflow](Translation_Workflow/README.md)。

1. 识别引擎、版本和资源格式，建立只读基线。
2. 查阅 [引擎工具](Game_Engine_Tools/README.md)，按需解包，在用户工作目录准备游戏专属提取和回填适配。
3. 仅导入对白、旁白；选项框保持原文，设置、菜单和图片文字排除。显示姓名等额外范围在游戏方案中明确。
4. 制作开头到首个选项前的预翻译补丁，人工验证字体、格式及原文选项显示后，再开始全量。
5. 按 [翻译工作流](Translation_Workflow/LinguaGacha_Agent工作流.md) 提取术语、逐批翻译、审校、导出，再回填构建和实机验收。

当前附带 **Artemis PF8 索引、解包、回封**工具，以及 TXT、KV-JSON、Message-JSON 翻译 CLI。尚无跨游戏通用的脚本解析器、字体转换器和安装器，需按游戏适配。“一键式”指宿主 agent 串联流程，不代表已有无需适配、自动译完整部游戏的命令。工具自测通过不等于补丁通过实机验收。

## 目录与分发

```text
VNG_Translator_Agent/
  AGENTS.md / CLAUDE.md       # 整体流程入口
  package.json               # 安装、检查与构建入口
  LinguaGacha_Agent/          # 翻译 CLI、技能、源码、内置规则、测试
  Game_Engine_Tools/          # 引擎工具、测试、用法与引擎适配说明
  Translation_Workflow/      # 跨引擎通用流程与空白实施模板
  check_scripts/             # 维护检查脚本、整合说明与分发验证
```

在取得所需分发授权后，技术上可只提供此目录的源码，排除 `node_modules`、`dist`、缓存和测试输出。运行 `python3 check_scripts/verify-portable.py` 可将干净源码复制到临时目录，重新安装、构建并检查。详细技术边界见 [整合说明](check_scripts/INTEGRATION.md)。

`check_scripts/` 只用于维护和分发验证；日常翻译、审校、解包与封包不调用其中的脚本。`npm run verify` 依赖该目录，`setup`、`build`、`doctor` 和翻译 CLI 则不依赖它。
