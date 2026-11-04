# 游戏实施目录约定

本目录随工具包分发，只保存 [game_templates 空白模板](game_templates/README.md) 与本说明。实际游戏记录和产物统一放在用户指定工作根目录的 `release/<game_id>/`，不写入工具包。

```text
工具包内：
Translation_Workflow/release/
  README.md
  game_templates/
    README.md
    实施方案.md
    实施日志.md
    结果与验收.md
    evidence/README.md

用户指定工作根目录内：
release/
  game-a/                     # 游戏 A 的记录与全部产物
  game-b/                     # 游戏 B 的记录与全部产物
  game-b-pc-v2/               # 需要独立基线的另一版本
```

`release` 在这里管理每个游戏的完整实施周期，包括计划、测试、翻译、审校和发布，不代表其中的游戏均已完成。实际完成情况以每个游戏的 `结果与验收.md` 为准。

`game_id` 使用小写英文字母、数字和连字符，游戏原名保存在 README。新增目录使用英文，文档文件名可保留中文；原始游戏资源名称不受此约定影响。`evidence/` 对应检查证据，包括命令输出、报告和截图。

新游戏复制模板到尚不存在的 `release/<game_id>/`，续做游戏直接读取已有记录和工程，不再复制模板覆盖。具体命令和批次目录见 [工作流程入口](../README.md)。
