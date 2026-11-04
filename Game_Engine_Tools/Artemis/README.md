# Artemis 引擎工具

通用目标为 Artemis 的 PF8 资源索引、解包与回封。引擎名相同不代表不同游戏的包格式、路径编码、脚本文法和补丁加载规则完全相同。

先阅读本页的工具用法与边界，再读取同目录的 [解包与汉化流程](解包与汉化流程.md)，了解 Artemis 的脚本、编码、字体和回填适配要求。跨引擎整体阶段与记录规范见 [通用实施流程](../../Translation_Workflow/通用实施流程.md)。

## 本地工具

[tools/pf8.py](tools/pf8.py) 是 Python 3.9+ 标准库脚本，支持 `list`、`extract` 和 `pack`（0.2.0）。不执行游戏脚本，不转换正文编码或自动合并更新；回封写入新文件，拒绝覆盖原包。

| 功能 | 行为 |
| --- | --- |
| 编码 | 必须显式指定 `--encoding cp932` 或 `utf-8`，解码失败即报错 |
| 索引 | 输出路径、原始名称字节、偏移、大小、保留字段和索引哈希 |
| 按需提取 | `--include` 可重复；使用 `/` 分隔的路径 glob，命令中用引号包围 |
| 内容处理 | 默认按索引 SHA-1 派生密钥进行逐条 XOR；不对正文转码 |
| 特例 | 已确认不加密的条目可显式传 `--plain-pattern`，不自动假定所有视频都相同 |
| 输出 | 要求全新输出目录和独立 manifest；记录原包及提取内容 SHA-256 |
| 边界 | 仅 PF8，索引上限 64 MiB；拒绝越界、路径穿越、重名和重叠数据条目 |

标准用法，以下均在仓库根目录执行。`/path/to/...` 是待替换的路径示例：

```sh
python3 Game_Engine_Tools/Artemis/tools/pf8.py list /path/to/game.pfs.002 --encoding cp932
python3 Game_Engine_Tools/Artemis/tools/pf8.py extract /path/to/game.pfs.002 --encoding cp932 --output /path/to/work/unpacked/002 --manifest /path/to/work/manifest/002.json
python3 Game_Engine_Tools/Artemis/tools/pf8.py extract /path/to/game.pfs.001 --encoding cp932 --include '_base/font/*' --output /path/to/work/unpacked/fonts --manifest /path/to/work/manifest/fonts.json
```

包内名称统一为 `/` 供磁盘输出，同时原始字节保存在 manifest。manifest 放在资源目录之外，避免将记录文件误打进游戏包。`entry_count` 是原包条目数，`selected_count`／`extracted_count` 是本次选择／提取数；`list` 不读取所有正文，也不计算整包哈希。

输出中断可能留下部分目录，此时不要把它作为成功结果。保留失败日志，下一次使用新的输出目录和 manifest。无 `--force` 选项。

## 验证与限制

合成样本测试命令：

```sh
python3 -B -m unittest discover -s Game_Engine_Tools/Artemis/tools -p 'test_*.py' -v
```

测试覆盖 CP932／UTF-8 路径、原名与明文哈希保留、跨读取块 XOR、选择性提取、显式明文例外、拒绝已有输出、错误编码、损坏索引和路径碰撞。真实游戏的检查结果记在对应实施目录，不代表已验证所有 Artemis 游戏。

**本分发包提供 PF8 解包与回封工具；不携带历史游戏专属的文本解析、字体和补丁安装适配器。新游戏需在用户工作目录中实现并验证这些适配。** PF8 解包成功并不能证明中文运行正常。特别是 CP932 资源名需要保持原始字节，新生成的 UTF-8 索引可能让旧版引擎找不到文件。

## 外部参考工具与来源

以下为前期调研资料，没有将第三方工具的可执行文件复制进本目录。使用前固定提交／版本，核对当前功能、平台和许可。

| 项目 | 用途与已知边界 |
| --- | --- |
| [pfs-rs](https://github.com/sakarie9/pfs-rs) | 列目录、解包、封包候选；所查写入实现使用 UTF-8 路径，旧版 CP932 游戏需适配 |
| [GARbro ArcPFS.cs](https://github.com/morkt/GARbro/blob/master/ArcFormats/Artemis/ArcPFS.cs) | PF8 读取与路径编码参考，可作为独立解包校验；该格式实现不支持写包 |
| [GalgameReverse artemis_pf8.py](https://github.com/YuriSizuku/GalgameReverse/blob/master/project/artemis/src/artemis_pf8.py) | 索引、SHA-1／XOR、回封参考；所查版本路径固定 UTF-8 且含 Windows 特定操作 |

本地脚本基于已核对的 PF8 布局编写，格式证据与上述读取／解包源码一致；未原样复制第三方工具源码。更换工具版本或接入新包变体后需重新验证。

## 回封与独立复核（0.2.0）

```sh
python3 Game_Engine_Tools/Artemis/tools/pf8.py pack /path/to/resources --manifest /path/to/full-extract-manifest.json --output /path/to/new.pfs
# 新增资源必须逐项声明：--add _base/font/example.otf
ruby Game_Engine_Tools/Artemis/tools/check_pf8.rb /path/to/new.pfs /path/to/resources
```

回封要求完整 extract manifest，保留条目顺序、原名称字节、保留字段与每条 XOR 策略；重算偏移和 SHA-1 索引密钥。资源内容可改长；不承诺保留原包物理填充或得到相同整包哈希。拒绝遗漏/未声明额外文件、路径冲突及外部符号链接。合成测试共 7 项。Ruby 复核器独立读取索引、尾表、XOR 与磁盘内容，仅用于路径 CP932 且所有条目均加密的包。
