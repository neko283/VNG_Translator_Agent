# Translation Workflow

本目录统一维护跨引擎通用的完整流程，从引擎识别、文本提取、预翻译到全量翻译、补丁构建和实机验收。引擎资源操作调用 [Game_Engine_Tools](../Game_Engine_Tools/README.md)，文本翻译与工程管理调用 [LinguaGacha_Agent](../LinguaGacha_Agent/README.md)。

## 阅读与执行顺序

1. 阅读 [通用实施流程](通用实施流程.md)，确认游戏版本、翻译范围、用户工作目录与阶段通过条件。
2. 识别引擎后，到 `Game_Engine_Tools/<引擎>/` 读取 `README.md`，再按其链接读取工具用法和引擎适配说明。可从 [引擎工具入口](../Game_Engine_Tools/README.md) 查找对应目录；不能只读通用流程就直接调用工具。
3. 做原文提取/回填往返，再制作开头到首个选项前的预翻译补丁；人工确认字体和格式后再进行全量翻译。
4. 按 [术语提取流程](术语提取流程.md) 整理并入库术语，按 [翻译与审校工作流](LinguaGacha_Agent工作流.md) 逐批翻译、审校和导出。小样与正式任务分别建立工程，均执行相应术语与审校步骤。
5. 按 [正式构建与安装流程](正式构建与安装流程.md) 回填、构建、安装/还原并实机验收，记录实际验证范围。

默认仅翻译对白和旁白。选项框、设置、菜单及图片文字保持原文；显示姓名等额外范围在游戏方案中明确。

## 建立游戏工作目录

工具包内的 [release/game_templates](release/game_templates/README.md) 始终保留空白模板。实际游戏统一保存在用户指定工作根目录的 `release/<game_id>/`；一个 `release` 下可以有多个游戏，每个游戏单独保存方案、日志、验收和产物。目录布局见 [release 说明](release/README.md)。

`game_id` 使用小写英文字母、数字和连字符，例如 `game-a`、`game-b-pc-v1`。游戏原名写在 README 中；不同版本需要独立基线时使用不同 ID。新增目录统一使用英文，Markdown 文件名可以保留中文。原始游戏资源的路径和包内名称按原样保留，不因目录命名约定而改名。

以下示例在工具包根目录执行；替换工作根目录和游戏 ID，目标游戏目录必须尚不存在：

```sh
VNG_WORK_ROOT='/用户指定的绝对路径'
GAME_ID='game-a'
mkdir -p "$VNG_WORK_ROOT/release"
cp -R Translation_Workflow/release/game_templates "$VNG_WORK_ROOT/release/$GAME_ID"
```

Windows 可使用文件管理器复制。用户工作目录结构如下：

```text
<user_work_root>/
  release/
    game-a/
      README.md / 实施方案.md / 实施日志.md / 结果与验收.md
      evidence/                # 命令输出、校验报告、截图等证据
      adapters/                # 当前游戏专属代码
      work/runs/<run_id>/
        manifest/ unpacked/ effective/ terms/ font/
        translation/
          input/ mapping/ context/ jobs/ changes/ output/ reports/
        patch_files/ build/ qa/
    game-b/
      ...                      # 另一游戏的独立记录与产物
```

本文及其他流程所称“游戏实施目录”，均指 `<user_work_root>/release/<game_id>/`。登记原版路径、版本、编码、加载优先级、实际工作目录和真实任务 ID。续做时继续已有游戏目录和批次的 `.lg`，不要重新复制模板覆盖记录，也不要在工具包内保存游戏数据。

## 维护边界

本目录只维护跨引擎共用步骤与实施模板。工具参数、命令示例以及引擎特有的脚本转换、编码、字体、补丁加载和验收约定，均维护在 `Game_Engine_Tools/<引擎>/`。Agent 识别引擎后按需读取对应目录；通用流程不重复维护这些说明。
