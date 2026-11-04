# 源码来源与独立性

原项目：neavo/LinguaGacha。复制基线：`b7b18772d52d2af40acb73c905179c9703749e3e`。

实施时先把原源码和资源复制到本项目，随后仅从副本读取、抽取和构建。最终 `upstream/` 只保留编译或类型检查所需的闭包，不包含其他格式适配器、桌面应用装配或原项目安装脚本。所有运行依赖由本项目自己的锁文件声明。

[原始文件 SHA-256 清单](upstream-hashes.json) 记录保留文件在修改前的摘要，供未来比对来源。未在下面列出的上游文件保持原内容。

|本地文件|改动原因|
|---|---|
|`upstream/src/backend/database/database-operations.ts`|替换桌面聊天 SDK 连接装配，保留原访问类和迁移调用；添加迁移版本预检、一致备份、同步事务边界|
|`upstream/src/backend/project/project-write-store.ts`|把缓存依赖收窄为小接口；增加事务内 guard/checkpoint，使原写入与新回执原子保存|
|`upstream/src/backend/project/agent-workspace-write.ts`|取消 PDF 写入执行分支，对非空页面写请求直接拒绝；原 Item、规则和重复组处理保留|
|`upstream/src/backend/project/agent-workspace-page-write.ts`|只保留供原工程类型契约使用的类型，移除 PDF 渲染代码|
|`upstream/src/backend/agent/workspace/schema.ts`|使用已独立安装的 `typebox`，解除原模型 SDK 的 Schema 重导出依赖|
|`upstream/src/backend/migration/migration-types.ts`|只保留数据库迁移类型，去掉桌面启动和应用服务类型装配|
|`upstream/src/backend/file/shared/zip-members.ts`|只保留路径校验函数，不引入 ZIP 读取功能和依赖|
|`upstream/src/shared/project-source-formats.ts`|保留格式分类事实，解除桌面本地化字典的类型依赖|
|`upstream/src/shared/error/index.ts`|只导出本地核心使用的错误能力，移除渲染进程错误上报装配|

TXT、KVJSON、MESSAGEJSON 适配器、Item 模型、工程访问类、各项工程迁移、术语和文本处理算法未重写。导出副本中的重复文本回填从原生成服务抽取到 `src/formats.ts`，原应用层生成服务本身不再携带。

`src/` 中的任务协议、批次准备、回执、恢复、宿主 CLI 和技能内容属于新实现。`scripts/validate-skill.py` 从本次使用的 skill-creator 校验脚本复制，再改为只接受本项目使用的扁平标量 frontmatter，避免要求额外 Python 包；它不是通用 YAML 校验器。

项目标为 private，未执行发布。运行不访问原仓库，也不使用指向外部源码或资源的符号链接。源码和文档的边界可用 `node scripts/check-boundaries.mjs` 验证。
