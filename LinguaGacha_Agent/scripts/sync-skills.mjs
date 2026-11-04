import { mkdir, writeFile } from 'node:fs/promises';
for (const host of ['.agents', '.claude']) {
  const directory=`${host}/skills/linguagacha`;
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/SKILL.md`,`---
name: linguagacha
description: 翻译或恢复本地 TXT、KV-JSON、Message-JSON 的 .lg 工程，支持术语复用与审校。
---

读取并遵循本项目的[共享翻译技能](../../../skills/linguagacha/SKILL.md)。
本入口所在目录的 ../../.. 是项目根目录。CLI、源码和资源都在该目录内。
`);
}
