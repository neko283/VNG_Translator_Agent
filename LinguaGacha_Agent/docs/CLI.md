# CLI 与提交协议

先在项目根目录执行 `node bin/lg-agent.mjs doctor`。运行时使用当前 shell 配置的 Node.js >=24.22.1，不自动安装 Node。构建命令为 `npm run build`。CLI 在 stdout 输出 JSON，错误写入 stderr 并返回非零退出码。

## 常用命令

```sh
node bin/lg-agent.mjs import ./input --project ./jobs/book.lg --source-language ALL --target-language ZH
node bin/lg-agent.mjs inspect ./jobs/book.lg
node bin/lg-agent.mjs start ./jobs/book.lg --workflow full
node bin/lg-agent.mjs next ./jobs/book.lg --task TASK_ID --limit 20
node bin/lg-agent.mjs apply ./jobs/book.lg --task TASK_ID --attempt ATTEMPT_ID --changes ./changes.json
node bin/lg-agent.mjs resume ./jobs/book.lg --task TASK_ID
node bin/lg-agent.mjs export ./jobs/book.lg --task TASK_ID --output ./output
```

`TASK_ID` 和 `ATTEMPT_ID` 必须替换成命令实际返回的值。`start --files a.txt,b.json` 限定文件；不指定时选择全部资产，不支持的格式会报错。`--workflow translate` 不额外要求术语调查及语义审校，但仍读取现有术语和执行结构检查。

新建工程默认源语言 `ALL`，避免对未知外语输入误作语言跳过；明确日语可用 `JA`，英语可用 `EN`。默认目标语言 `ZH`。已有工程沿用工程语言，`start` 不隐式修改语言或重置译文。`--retry-errors` 明确纳入 `ERROR`；`--retranslate` 明确重译范围内已完成条目。`--clean-ruby` 启用原注音清理规则。

`query` 返回任务范围内原文、译文、指纹和质量检查；`receipt --attempt ID` 返回已保存回执；`pause --reason TEXT` 保存暂停原因。`resume` 重读真实译文与规则，返回当前剩余工作。临时草稿可放在 `project.lg.agent-work/`，该目录不是恢复必需品，CLI 不依赖它的内容。

## 模型译文入口

`next` 会返回工程源/目标语言、工作流与当前规则。其 `items[].request` 是经过原译前流程处理的模型输入。把结果写成 UTF-8 JSON：

```json
{
  "translations": [
    {"item_id": 1, "fp": "从 next 原样复制", "text_dst": "你好", "actor_dst": "爱丽丝"}
  ]
}
```

`actor_dst` 仅用于有姓名请求的条目。CLI 执行原译后恢复和替换一次，检查保护段及行数，然后通过原工程写入口提交。结构检查失败的条目进入 `rejected`，其他条目仍按原部分接受规则提交。

## 原条目补丁入口

审校修改或已经准备好的最终译文使用：

```json
{
  "items": [
    {"item_id": 1, "fp": "从 next 原样复制", "dst": "你好", "status": "PROCESSED"}
  ]
}
```

允许的更新字段为 `dst`、字符串 `name_dst`、原人工状态 `NONE / PROCESSED / EXCLUDED`。姓名只更新原模型的可见槽位，其余槽位保留。省略的字段不变；空译文也可以显式确认为已处理。

`--changes` 也可接受单个 `updates.jsonl`，或包含 `items/updates.jsonl`、`glossary/creates.jsonl` 等文件的目录。目录布局沿用原 `changes/` 内部结构。首版目录入口只接受条目与四类质量规则；PDF、提示词等目录不提供写入能力。

## 术语及规则

```json
{
  "quality": {
    "glossary": {
      "creates": [
        {"src": "Alice", "dst": "爱丽丝", "info": "女主角", "case_sensitive": false, "sort": 0}
      ]
    }
  },
  "terms": {"done": true, "sources": ["用户提供的角色表"], "notes": "已确认人名。", "candidates": []}
}
```

支持 `glossary`、`text_preserve`、`pre_replacement`、`post_replacement`。创建记录提交全部原业务字段和 `sort`；修改用 `id/fp` 加需要修改的字段；删除用 `id/fp`。身份和指纹从 `next.quality` 获取，不自行编造。

- 术语字段：`src/dst/info/case_sensitive`。
- 文本保护字段：`src/info`，其中 `src` 为正则表达式。
- 替换字段：`src/dst/regex/case_sensitive`。
- `sort` 沿用原排序协议；推荐从当前规则列表选择插入位置。

开关和保护模式单独设置：

```sh
node bin/lg-agent.mjs configure ./jobs/book.lg --kind glossary --enabled true
node bin/lg-agent.mjs configure ./jobs/book.lg --kind pre_replacement --enabled true
node bin/lg-agent.mjs configure ./jobs/book.lg --kind text_preserve --mode custom
```

这些命令使用原规则配置存储及修订校验。设置变更后重新 `next`，旧批次不能继续按旧规则提交。已提交译文保留；全流程任务会重新要求审校。

`terms` 只能在术语阶段提交。`done:false` 可持久化未完成调查、来源和候选；`done:true` 在同批规则没有拒绝记录时推进任务。正式术语保存在原 `rules` 中，不在 `terms.candidates` 中生效。

## 审校

```json
{
  "items": [{"item_id": 1, "fp": "当前指纹", "dst": "修订后的译文"}],
  "reviews": [{"item_id": 1, "fp": "同一当前指纹", "verdict": "pass", "note": "核对原文与术语，修正了主语。"}]
}
```

没有修订时只提交 `reviews`。结论支持 `pass`、`needs_revision`；关联译文或规则变化后旧结论失效。审校结论是新任务元数据，不修改 `Item.status` 语义。

## 回执与恢复

- `item_results` 列出条目是否接受、是否实际改变和是否有拒绝记录；`reviewed_item_ids` 列出本次保存的审校，`quality_entry_ids_after` 给出涉及规则类别的提交后身份列表。`checkpoint_saved:true` 表示本次检查点已经持久化。
- 原业务 `status` 为 `applied / partial / rejected / unchanged`。只保存审校或任务检查点而未修改原条目/规则时，业务状态可以是 `unchanged`。
- 回执和本次接受的译文在同一 SQLite 事务保存；同 ID、同内容重放返回 `replayed:true`，不再写业务数据。
- 修复被拒绝内容时重新 `next`，使用新的尝试 ID。旧 ID 携带不同内容会被拒绝。
- 回复丢失时先查询回执；没有回执则可以原样重试。同一事务中断会同时回滚译文与回执。
- 多个未完成任务时显式指定 `--task`。工程搬移后使用新路径和原任务 ID。
- 已导出文件会记录摘要。`resume` 检测到文件缺失或内容不一致时，返回 `export` 阶段重新生成。
- 用户外部原始文件变化不会自动替换 `.lg` 资产；工程内资产变化会阻止旧任务继续，需重新建立任务范围。

## 输出规则

输出目录由 `--output` 指定，TXT 双语文件位于其 `bilingual/` 子目录。目录不能包含工程数据库；输出路径相互冲突或经过符号链接会在写出前拒绝。

保留原格式写回：TXT 统一 `\n`；KV-JSON 从工程原资产回填；Message-JSON 重建 `name/names/message`，不保留额外字段。零条目 TXT/JSON 不产生文件，并在 `zero_item_assets` 报告。

可导出未完成工程；回退列表包含未直接标为已处理的条目，重复项可由原生成逻辑回填。`status:completed` 才表示当前工作流范围已满足；CLI 不声称自动检查可代替语义审校。
