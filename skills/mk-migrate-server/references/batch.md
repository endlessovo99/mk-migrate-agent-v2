# 批次操作

已有批次先查 `batch status`、`batch item`，不要重新导入相同源绕过未知写入。新批次在 `MK_BATCH_DATABASE_URL` 已配置时使用；没有库时，单项/逐项迁移不需要先部署数据库。所有下面的 CLI 参数都加在 `mk-migrate-secure run --` 后。

## 准备清单

manifest 包含 `version: 1`、`name`、`migrationKey`、`baseUrl`、`targetCategoryId`、`executionConcurrency` 和 `items`。每项含 `sourcePath`，可含 `templateName` 和 `executionOptions`。源路径相对 manifest 所在目录。

- 使用明确的任务范围，固定完整 origin 和分类。沿用同一任务的 `migrationKey`，不为绕过重复/不明写入换 key。
- `executionConcurrency` 默认采用现有同 origin 限制；新 origin 从 `1` 开始，不擅自提高已配置并发。
- 在每项 `executionOptions.fallbackFdIds` 固定有效的 `person/organization/group/post/role`，环境覆盖优先，前四项无覆盖时使用 `fallback-and-recovery.md` 中对应版本默认；未配置 role 时省略。批量执行不会自动把这些 env 变量复制进项目。
- 按任务和对应配置加入 `allowTemplateAuthorizationFallback`、`allowMissingDirectPersonFallback`、`allowMissingDirectPostFallback` 布尔值。确有证据的逐 ID 人员兜底用 `directPersonFallbackIds`。
- 明确映射分别使用 `participantOverrides`、`templateAuthorizationOverrides`、`directParticipantOverrides`，不能跨作用范围。manifest 不包含用户名、密码、模型 key 或数据库 URL。

## 从准备到写入

逐条运行并读取真实 JSON；`--out` 常只在终端打印 `{wrote, id}`，必须打开它指向的完整报告，不要求所有批次输出都有 `ok` 字段。

```bash
mk-migrate-secure run -- batch create "$MK_TASK_MANIFEST"
mk-migrate-secure run -- batch prepare "$MK_TASK_BATCH_ID" --concurrency 1
mk-migrate-secure run -- batch status "$MK_TASK_BATCH_ID" --out "$MK_TASK_BATCH_STATUS"
```

从 status 获取 `proposal` 和 `approvalDigest`，核对项目、目标、分类、DSL 和映射/兜底仍在用户任务范围内。用户明确要求执行批次时，Agent 直接登记实际方案的内部审批并运行，不要求用户再回复确认。记录用户原始任务作为授权依据；`--actor codex-server` 如实表示执行代理，不冒充用户签字。

```bash
mk-migrate-secure run -- batch approve "$MK_TASK_BATCH_ID" \
  --expected-digest "$MK_TASK_APPROVAL_DIGEST" --confirm-write --actor codex-server
mk-migrate-secure run -- batch run "$MK_TASK_BATCH_ID" --confirm-write --concurrency 1
mk-migrate-secure run -- batch status "$MK_TASK_BATCH_ID" --out "$MK_TASK_BATCH_RESULT"
```

每次输出文件使用新路径。内部批准只覆盖准备好的项目；新增/变化项目不能沿用旧 digest。范围未变且只是正常准备进展时，检查新 proposal 后可依据原任务继续登记；改变业务语义、越出范围或原用户明确要求暂停审批时不能自动批准。

## 中断与修复

- `batch recover` 只处理过期租约；先查状态，活跃任务不并发重启。
- `batch retry` 只用于已暂停批次中、没有远端副作用的 blocked 项；先解决导致阻塞的问题。成功项目保持完成。
- `outcome_unknown` 不重放；`needs_repair` 不返回新建。`pause` 不会抹掉正在执行的写入。
- 已导入项目的兜底参数不能靠修改 env 改变。只有 `retry` 也不会新增漏掉的开关。需要按原工具的 `execution_options` 修复记录、preview 和 `--confirm-apply` 路径应用既定策略；保存完整适用性证据、等待暂停，重新检查新 proposal。可以在原任务授权范围内完成纯本地参数修正，但不能跳过工具的逐项校验或直接改数据库。
- 引擎摘要变化必须走工具既有 `reprepare` 修复；不绕过 `BATCH_ENGINE_CHANGED`。更换引擎、已有目标修复、回调补写不由普通失败重试自动触发。
- 锁定草稿、已发布表单或迁移记录修复需要另行确定的范围及摘要等条件；本 skill 不提供快捷放行命令。

最后分列成功、准备阻塞、已有目标待修复、写入结果不明；不能用批次命令结束来代表所有项目成功。
