# 服务器 Codex 迁移 skill 的安装和使用

`mk-migrate-server` 只指导服务器上的 Codex 使用已解锁的迁移工具。用户明确要求迁移时，Agent 完成检查后直接新建草稿，不再等待额外的“确认写入”；已配置兜底按对应类型主动使用。程序的确认参数、类型校验、未知写入保护及特殊修复要求保留。

skill 源文件在 `skills/mk-migrate-server/`。交付压缩包只包含 skill、任务模板、安装说明和版本清单，不包含引擎源码、输入 XML、配置或凭据。它不更新服务器引擎，也不修改 Codex 系统权限。

## 1. 上传文件

通过现有 FileZilla/SFTP 通道，将这两个文件放到服务器 `/var/lib/mk-migrate/`：

- `mk-migrate-server-20261011.tar.gz`
- `mk-migrate-server-20261011.tar.gz.sha256`

不用从 Mac 迁移 Node、npm 或 Codex。沿用服务器已有环境。以下命令全部在服务器普通堡垒机终端执行，使用实际运行 Codex 的账号；当前 `mk-migrate-secure` 启动器要求 Linux root。

## 2. 安装到运行 Codex 的账号

下面先校验包，再解压到新目录；已安装的同名 skill 会移到独立备份目录，原有业务数据、任务和配置保持不变。

```bash
(
  set -eu
  cd /var/lib/mk-migrate
  sha256sum -c mk-migrate-server-20261011.tar.gz.sha256
  MK_SKILL_STAGE="$(mktemp -d /var/lib/mk-migrate/skill-install-XXXXXXXX)"
  tar -xzf mk-migrate-server-20261011.tar.gz -C "$MK_SKILL_STAGE"
  test -f "$MK_SKILL_STAGE/mk-migrate-server/SKILL.md"
  MK_SKILL_ROOT="$HOME/.agents/skills"
  install -d -m 700 "$MK_SKILL_ROOT"
  if [ -e "$MK_SKILL_ROOT/mk-migrate-server" ] || [ -L "$MK_SKILL_ROOT/mk-migrate-server" ]; then
    MK_SKILL_BACKUP="$(mktemp -d "$HOME/mk-migrate-skill-backup-XXXXXXXX")"
    mv "$MK_SKILL_ROOT/mk-migrate-server" "$MK_SKILL_BACKUP/mk-migrate-server"
    printf '旧 skill 已保留：%s\n' "$MK_SKILL_BACKUP/mk-migrate-server"
  fi
  cp -a "$MK_SKILL_STAGE/mk-migrate-server" "$MK_SKILL_ROOT/mk-migrate-server"
  test -f "$MK_SKILL_ROOT/mk-migrate-server/SKILL.md"
  printf '已安装：%s\n' "$MK_SKILL_ROOT/mk-migrate-server/SKILL.md"
)
```

官方用户级目录是 `$HOME/.agents/skills`，root 账号通常对应 `/root/.agents/skills`。安装给哪个账号，就由哪个账号运行 Codex；不要同时向多个发现目录复制同名 skill。安装无需联网和下载依赖。

## 3. 检查并启动 Codex

等待正在执行的迁移完成后，重新启动 Codex，以加载新 skill。不要为了安装 skill 中断正在写入的进程或锁定引擎。

```bash
cd /var/lib/mk-migrate
codex --version
mk-migrate-secure status
codex \
  --cd /var/lib/mk-migrate \
  --sandbox workspace-write \
  --ask-for-approval on-request \
  --add-dir /run/mk-migrate \
  -c sandbox_workspace_write.network_access=true \
  --no-alt-screen
```

应看到迁移工具为 `unlocked`，并能在 Codex 技能列表找到 `mk-migrate-server`。这些启动选项沿用项目已有服务器操作方式；组织策略和实际 CLI 版本仍以服务器为准。`/run/mk-migrate` 用于运行控制锁，代码子目录仍由系统只读挂载。

若技能没有被发现，先核对账号、安装文件和 Codex 版本。也可以在会话中明确要求读取该账号下 `.agents/skills/mk-migrate-server/SKILL.md`。不能以此绕过系统策略。

迁移业务授权与 Codex 系统命令审批是两件事：skill 取消重复的业务确认，不修改系统沙箱、网络策略或审批配置。迁移工具的模型配置也不替代 Codex 自己的模型/登录配置。

## 4. 下达新任务

在 Codex 中发送下面的文字，将源目录和分类 ID 换成真实值：

```text
使用 $mk-migrate-server，把 input/实际源流程目录 迁移到当前配置的 NewOA，目标分类 fdId 为实际分类ID。
按已经配置的兜底主动处理，检查通过后直接写入新的 MK_TEST_ 草稿，完成回读和迁移记录提交，不再向我索取写入或兜底确认。
保留完整报告；未知写入结果不要重试。
```

只准备不写入时，明确说“只翻译”“只检查”或“只预演”。如果用户没有指定范围且 input 中有多个流程，Agent 应问范围；如果明确要求处理整个目录，则处理整个范围。

持久任务模板在安装目录的 `assets/goal.md`。新建任务时复制到新的任务位置再填写；空模板不是授权。不要直接覆盖已有 `/var/lib/mk-migrate/goal.md`。

## 5. 继续旧任务，消除旧确认要求

旧会话可能仍记得“等用户确认才执行”。如果原 `goal.md` 也有这个要求，仅安装 skill 不会自动改掉它。可向服务器 Codex 发送：

```text
使用 $mk-migrate-server，继续 goal.md 中原来指定的迁移任务，保留原任务范围、目标、分类和所有执行记录。
我更新该任务的操作规则：明确要求迁移即授权该范围的新建 MK_TEST_ 草稿、回读及迁移记录提交；已配置兜底主动使用，包括对应的模版权限和直接人员／岗位开关，不再等待额外的写入或兜底确认。
先备份 goal.md，再仅修改与本条冲突的确认和等待要求；不要清除历史状态或其他限制。
继续前检查已有报告、写入意图和目标记录。只有实际证据证明尚未写入的失败才按现有路径恢复；未知写入和已有目标禁止重复新建。同一阻塞不要刷屏重复报告。
```

这条文字由用户发送后，才是旧任务的新指令。Agent 保存原文作为授权依据，不伪造曾经的确认。不能仅因为旧日志写着“未完成”就重复执行。

## 6. 引擎和配置的对应关系

- `NEWOA_BASE_URL` 来自服务器有效 env，命令行 `--base-url` 可覆盖；批次使用已保存的 `baseUrl`。改变 env 不会改变旧批次目标。
- 当前 skill 的 HTTPS oaqas 支持依赖引擎已包含 `https://oaqas.shanghai-electric.com` 的兜底白名单和原生表单规则登记。安装 skill 不会给旧引擎添加这些能力；更新包仍走现有加密发布流程。
- 兜底变量和开关在 skill 的 `references/fallback-and-recovery.md`；实际目标存在性和类型仍由执行器验证。不修改或输出凭据。
- 批次内部审批可以由 Agent 根据真实用户迁移任务和实际方案登记；digest、版本及未知写入隔离继续生效。特殊已有目标修复仍需要其原有单独授权条件。
- 固定迁移记录回调 `http://oadev.shanghai-electric.com/data/sys-transfer/transferRecord/add` 不随模板 origin 改变。普通迁移使用既有合同，不自动改成 HTTPS 或其他主机。

维护时将匹配版本的 skill 与引擎一起交付，但分开安装；skill 保持在账号技能目录，不放进加密源码运行目录。skill 包的 `MANIFEST.json` 记录源快照和文件摘要，不代表服务器已安装该引擎版本。

## 验证边界

交付前检查 skill 格式、相对引用、命令与 CLI 参数一致性、安装 shell 语法、压缩包内容及校验和，并在隔离目录验证首次安装和备份更新。此类检查不代表已登录真实服务器、真实模型行为通过或已完成 NewOA 迁移。

官方安装目录依据：[Codex 技能发现目录](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。系统权限边界见 [Codex 审批与安全](https://learn.chatgpt.com/docs/agent-approvals-security)。
