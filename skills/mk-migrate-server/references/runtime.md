# 运行入口和单项命令

## 环境

默认业务目录 `/var/lib/mk-migrate`；输入在 `input/`，任务产物可集中保存于 `reports/` 下的新私有目录。启动器自动加载 `/etc/mk-migrate/newoa.env`；已导出的同名环境变量优先。部署指定了其他路径时沿用实际路径。

```bash
cd /var/lib/mk-migrate
mk-migrate-secure status
```

必须看到 `status: unlocked`，记录返回的 `releaseId`、`sha256`。`locked`、`incomplete`、`awaiting-ticket`、`expired-ticket` 只报告给维护者处理，迁移任务不自动解锁。当前启动器要求 Linux root；权限错误不能当成锁定状态。

核对已安装版本支持的参数可运行 `mk-migrate-secure run -- help`。当前 CLI 对帮助输出返回退出码 `2`，这是显示用法，不是迁移失败。不要为探测能力调用 `execute`。本 skill 需要模板授权兜底、直接人员／岗位兜底、执行报告写入状态字段；HTTPS oaqas 还需要对应版本的兜底白名单和原生表单规则登记。帮助输出不能证明白名单已更新；未知版本与发布说明核对，实际拒绝时报告版本不匹配，不用 HTTP 偷换 HTTPS。

## 有效配置

目标优先级：用户本次明确指定的根地址 > 有效 `NEWOA_BASE_URL` > 工具默认 `https://p-sit.onewo.com`。读取并记录实际根地址，不把模型 API 地址当成 NewOA。分类 fdId 从用户任务或明确的部署任务配置取得；CLI 没有默认分类，不从目录名或样例猜测。

可在普通 shell 中用下面的只读命令提取允许展示的配置。它使用 Node 的 `--env-file`，不会执行 env 文件里的 shell 文本，也不导入引擎源码。部署 Node 需支持该选项；配置文件不存在而全部配置已在进程环境中时，省略 `--env-file`。不要改用 `cat`、`env` 或 `set` 打印所有配置。

```bash
node --env-file=/etc/mk-migrate/newoa.env --input-type=module <<'NODE'
const env = process.env;
const configuredBaseUrl = env.NEWOA_BASE_URL?.trim() || 'https://p-sit.onewo.com';
let baseUrl;
try {
  const url = new URL(configuredBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error();
  baseUrl = url.origin;
} catch { console.log(JSON.stringify({ error: 'NEWOA_BASE_URL_INVALID' })); process.exit(1); }
const fallbackKeys = {
  person: 'NEWOA_FALLBACK_PERSON_FD_ID', organization: 'NEWOA_FALLBACK_ORGANIZATION_FD_ID',
  group: 'NEWOA_FALLBACK_GROUP_FD_ID', post: 'NEWOA_FALLBACK_POST_FD_ID', role: 'NEWOA_ROLELINEBACK_FD_ID'
};
const configuredFallbackFdIds = Object.fromEntries(Object.entries(fallbackKeys)
  .filter(([, key]) => env[key]?.trim()).map(([kind, key]) => [kind, env[key].trim()]));
const present = Object.fromEntries(['NEWOA_USERNAME', 'NEWOA_ENCRYPTED_PASSWORD', 'OPENAI_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'AGENT_REVIEW_CHECKPOINT_KEY', 'MK_BATCH_DATABASE_URL']
  .map(key => [key, Boolean(env[key]?.trim())]));
console.log(JSON.stringify({ baseUrl, configuredFallbackFdIds, present }, null, 2));
NODE
```

保存非敏感配置快照；执行时用明确的 `--base-url` 绑定已解析目标。`configuredFallbackFdIds` 没有某一项不等于工具没有内置默认值，见兜底表。凭据存在性为 true 不代表登录成功，最终以工具结果为准。

## 新任务与准备

开始前按源模板 ID、源文件摘要、目标和分类检查已有任务、批次和执行报告，不能只看新输出目录是否为空。若配置了批次库，使用 `batch list`、`batch status`、`batch item` 查询关联记录。路径或关联不清时只调查，不重复迁移。

以下变量由 Agent 根据真实任务填写，不把占位文本直接执行。已经明确要求处理整个目录时处理完整范围，不擅自缩成一个样例。每个源流程采用一个产物目录：

```bash
umask 077
MK_TASK_SOURCE='/var/lib/mk-migrate/input/实际源流程目录'
MK_TASK_ORIGIN='实际已解析的HTTP或HTTPS根地址'
MK_TASK_CATEGORY='实际目标分类fdId'
MK_TASK_DIR="$(mktemp -d /var/lib/mk-migrate/reports/task-XXXXXXXX)"
```

保存 `task.json`：用户任务原文、源路径/模板 ID/原 XML 摘要、目标/分类、发布标识、已有记录检索结果、skill 版本。文件权限 `600`，新增记录不覆盖历史。源名称以 XML 和工具解析为准。

逐条调用并读取输出；不要把下面命令粘成忽略中间状态的一键流水线：

```bash
mk-migrate-secure run -- clean "$MK_TASK_SOURCE" --out "$MK_TASK_DIR/source-draft.json"
mk-migrate-secure run -- draft "$MK_TASK_DIR/source-draft.json" --out "$MK_TASK_DIR/dsl-draft.json"
mk-migrate-secure run -- check draft "$MK_TASK_DIR/dsl-draft.json"
mk-migrate-secure run -- agent-review "$MK_TASK_DIR/source-draft.json" "$MK_TASK_DIR/dsl-draft.json" \
  --out "$MK_TASK_DIR/migration.dsl.json" \
  --report-out "$MK_TASK_DIR/agent-review.report.json" \
  --checkpoint-out "$MK_TASK_DIR/agent-review.checkpoint.json"
mk-migrate-secure run -- check trust "$MK_TASK_DIR/source-draft.json" "$MK_TASK_DIR/migration.dsl.json"
mk-migrate-secure run -- check execute "$MK_TASK_DIR/migration.dsl.json"
mk-migrate-secure run -- dry-run "$MK_TASK_DIR/migration.dsl.json" --out "$MK_TASK_DIR/dry-run.report.json"
```

- `clean`、`draft` 离线；`agent-review` 调用迁移配置中的模型，和外层 Codex 的模型配置分开。
- 保存各阶段 JSON 及退出码。`check` 的退出码可能是 `0` 而 `ok: false`；检查 JSON。`needs_manual` 仅在 `ok: true`、可信且可执行时允许继续，不能仅凭状态名称放行。
- 不调用 `trust --external-agent-reviewed` 冒充审查通过，不手工设置 trust、不改源证据、不把 unresolved 动作标成已完成。
- 缺配置只报变量名。审查签名密钥保持稳定，不因为 checkpoint 失败就换 key。审查中断且没有写入时，可沿用同源、同草稿、同 key 和兼容版本的 `--resume-from`；新一轮的 out/report/checkpoint 使用新路径，保留上一轮文件。工具会验证 checkpoint，拒绝后不强制恢复。

## 写入和结果

`dry-run` 不查询真实 NewOA，不宣称此时人员已匹配。写入前按 `fallback-and-recovery.md` 选择必要开关，保存 `execution-plan-001.json`（DSL SHA-256、目标、分类、有效兜底/映射、用户任务引用和完整参数）。紧接着以独占创建方式保存 `write-intent-001.json`（计划摘要、开始时间、预定报告路径）；创建失败不执行。只使用新的报告路径，禁止覆盖旧回执。

下面三项兜底开关适用于已配置对应类型、且任务允许兜底的情况。无对应配置或用户禁用的开关应省略；不能为了套用示例临时编造配置：

```bash
mk-migrate-secure run -- execute "$MK_TASK_DIR/migration.dsl.json" \
  --base-url "$MK_TASK_ORIGIN" --target-category-id "$MK_TASK_CATEGORY" \
  --confirm-write \
  --allow-template-authorization-fallback \
  --allow-missing-direct-person-fallback \
  --allow-missing-direct-post-fallback \
  --out "$MK_TASK_DIR/execution-001.report.json"
```

每次启动 `execute` 都可能产生远端副作用。命令完成后保存退出码、完整报告和必要的脱敏错误。失败后先按恢复表判断，不能直接再执行本命令。原始可信 DSL 保持不变，运行期身份替换由执行器生成并回读验证。

`ok: true` 后检查创建 fdId、模板草稿状态、回读和迁移记录结果再汇报完成。`readback_failed`、`transfer_record_failed` 不能报迁移成功。迁移记录回调固定为 `http://oadev.shanghai-electric.com/data/sys-transfer/transferRecord/add`，与目标模板 origin 分开；正常授权包含工具的这一提交，不擅自改地址或重试回调。
