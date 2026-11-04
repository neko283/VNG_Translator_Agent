# Game Engine Tools

本目录按引擎存放资源索引、解包、封包工具、对应测试、使用方式和引擎适配说明。跨引擎通用的翻译、补丁制作及验收流程放在 [Translation_Workflow](../Translation_Workflow/README.md)。

## 可用工具

| 引擎 | 能力 | 使用说明 |
| --- | --- | --- |
| Artemis | PF8 索引、按需解包、manifest 驱动回封、独立复核 | [Artemis README](Artemis/README.md) |

## 目录约定

```text
Game_Engine_Tools/
  README.md
  Artemis/
    README.md                  # 工具入口、参数、示例、格式边界和来源
    解包与汉化流程.md          # 本引擎的资源、脚本、编码及回填适配说明
    tools/
      pf8.py                   # 索引、解包、封包
      check_pf8.rb             # 独立复核
      test_pf8.py              # 合成样本测试
```

新增引擎时增加对应目录、工具和使用说明，登记支持的格式、运行环境、参数、输入输出、限制及验证方法。工具应通过参数接收路径，不硬编码具体游戏名、任务 ID 或机器路径。

原始游戏资源与所有工具输出保存到用户指定目录。引擎特有的工具用法、字体、回填和验收说明维护在本目录的 `<引擎>/` 下，由该引擎的 README 引导读取；游戏实施模板维护在 `Translation_Workflow/release/game_templates/`。
