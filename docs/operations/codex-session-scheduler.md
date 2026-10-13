# 服务器 Codex session 调度

每个任务处理一个源表单及配对流程，通过已有 `mk-migrate-secure` 完成 DSL、审查、dry-run、新建草稿、回读和迁移登记。调度器只负责导入、派发及记录；不包含迁移引擎，不修改其写入或特殊修复门禁，不需要新数据库。服务器需 Linux、systemd、Node.js 20+、Codex CLI 和已解锁的迁移工具；沿用现有 root 运行账号。

## 时段配置与容量

按 `Asia/Shanghai` 计算，不依赖服务器系统时区。周一至周五为工作日，周六日为非工作日，不考虑节假日和调休。下面是默认时段，批次大小、间隔、起止时间均可配置。

| 时间 | 每批最多启动 | 间隔 |
| --- | ---: | ---: |
| 工作日 07:00–19:00 | 10 | 20 分钟 |
| 工作日 19:00–次日 07:00 | 20 | 15 分钟 |
| 周末全天 | 20 | 15 分钟 |

白天从 07:00 起到 18:40；夜间从 19:00 起，每刻钟一个时隙。timer 每分钟检查一次，秒级偏差不会多派。当前时隙只消费一次；重启或停机后不追补旧时隙、不补发“空闲名额”。07:00 只改变新任务派发，已有 session 自然完成。

全局 `maxSessions` 初始为 **20**，限制调度器启动的所有自动和手动任务总数，独立于每批数量。还有 3 GB 系统可用内存余量、每个新任务 512 MB 估计预算及 5 GB 数据盘余量；不足时少派或跳过。任务在同一波内集中启动，内存估计不等于实测上限。根据单任务及子进程内存、完整耗时和成功率再调整；不能承诺默认值满足最终吞吐量。

## 上传和安装（服务器执行）

将 `mk-codex-scheduler.tar.gz`、同名 `.sha256` 和 `INSTALL.md` 通过 FileZilla/SFTP 上传到 `/var/lib/mk-migrate/`。无需上传项目源码、Node、npm、Codex、模型认证或 NewOA 凭据。

```bash
(
  set -eu
  cd /var/lib/mk-migrate
  sha256sum -c mk-codex-scheduler.tar.gz.sha256
  MK_SCHEDULER_STAGE="$(mktemp -d /var/lib/mk-migrate/scheduler-install-XXXXXXXX)"
  tar -xzf mk-codex-scheduler.tar.gz -C "$MK_SCHEDULER_STAGE"
  sh "$MK_SCHEDULER_STAGE/mk-codex-scheduler/install.sh"
)
```

安装器验证内部文件摘要、创建独立版本目录和命令入口，保留已有配置/状态/skill；缺少 server skill 时安装包内版本。首次安装队列暂停，派发 timer 不启用，独立采样 timer 自动启用。已有同名 skill 不覆盖，请核对其为本项目服务器操作版本。更新时只需暂停领取；运行中的 worker 继续使用其原安装目录，旧目录不得删除。安装器在新版本目录保存 `previous-config.json`，给缺少 `schedule` 的旧配置补入原有默认时段，缺少 `maxAutoRepairAttempts` 时补入 10，不重置已调过的阈值。

```bash
mk-codex-scheduler doctor
mk-codex-scheduler status
```

`doctor` 仅检查本机命令、Codex 参数和引擎解锁状态，不调用模型或 NewOA，不能证明认证、网络、沙箱或持续容量。Codex 使用运行账号已保存的配置/登录；`agent-review` 继续使用迁移工具配置。若 Codex 的自定义 provider 依赖 shell 环境变量，通过服务器安全编辑器写入 `/etc/mk-migrate/codex-scheduler.env`，权限必须为 `600`，使用 `KEY=value`，不要放进任务清单或命令行。systemd 不会继承交互终端的临时 export；不得把凭据回传聊天。迁移凭据仍由启动器从原配置加载。

## 更新已有安装，不中断 session（服务器执行）

将本次压缩包和校验文件上传到 `/var/lib/mk-migrate/`，执行：

```bash
(
  set -eu
  cd /var/lib/mk-migrate
  sha256sum -c mk-codex-scheduler.tar.gz.sha256
  mk-codex-scheduler pause
  systemctl stop mk-codex-scheduler.timer
  MK_SCHEDULER_STAGE="$(mktemp -d /var/lib/mk-migrate/scheduler-update-XXXXXXXX)"
  tar -xzf mk-codex-scheduler.tar.gz -C "$MK_SCHEDULER_STAGE"
  sh "$MK_SCHEDULER_STAGE/mk-codex-scheduler/install.sh"
  mk-codex-scheduler config
  mk-codex-scheduler doctor
  systemctl start mk-codex-sampler.service
  mk-codex-scheduler metrics
  mk-codex-scheduler resume
  systemctl enable --now mk-codex-scheduler.timer
  systemctl list-timers mk-codex-scheduler.timer mk-codex-sampler.timer
)
```

这里只停止派发 timer，不停止任何 `mk-codex-task-*` 工作单元。安装器持有派发锁、原子切换命令入口，已运行任务的代码路径、配置快照和产物目录保留。完成后不重新导入原任务。若原本打算继续暂停，省略最后的 `resume` 和派发 timer 启用命令；采样仍照常运行。命令返回 75 表示锁正忙，本次未派发，待当前控制操作完成后再执行更新步骤，不需杀 worker。

## 生成和审核任务清单

先通过服务器编辑器创建 `/var/lib/mk-migrate/migration-instruction.txt`，记录真实操作者本次授权的源范围、目标、分类、允许的兜底和限制。调度器安装不等于对未指定业务任务的写入授权。

将下列变量换成真实值。`plan` 只生成清单，不写 NewOA；输入树递归发现单 XML 或成对目录。一个配对目录只能含一个 SysFormTemplate，歧义输入会拒绝；全部 XML 关联仍由现有 `clean` 验证。

```bash
MK_INPUT_ROOT='/var/lib/mk-migrate/input/本批实际目录'
MK_TARGET_ORIGIN='实际HTTP或HTTPS根地址'
MK_TARGET_CATEGORY='实际分类fdId'
MK_OPERATOR='实际操作者'
MK_MANIFEST='/var/lib/mk-migrate/migration-manifest-001.json'

mk-codex-scheduler plan \
  --input-root "$MK_INPUT_ROOT" \
  --base-url "$MK_TARGET_ORIGIN" \
  --target-category-id "$MK_TARGET_CATEGORY" \
  --actor "$MK_OPERATOR" \
  --instruction-file /var/lib/mk-migrate/migration-instruction.txt \
  --out "$MK_MANIFEST"
```

清单是 `version/baseUrl/targetCategoryId/actor/userInstruction/items`，每项只有 `sourcePath`。可以在导入前按源范围和分类拆分清单；不在清单中放账号、密码或模型 key。核对清单后，下面的显式参数确认该清单的正常新建草稿写入范围：

```bash
mk-codex-scheduler pause
mk-codex-scheduler import --manifest "$MK_MANIFEST" --confirm-write
mk-codex-scheduler status
```

导入时只做离线 `clean`，冻结 XML 字节和摘要、源身份、目标、授权原文和引擎发布标识。大清单逐项处理，发生失败会保留已成功导入的项目且队列仍暂停；修正输入后重新导入相同清单会跳过相同任务。相同 origin + 源身份始终沿用同一任务 ID，改路径、改清单名或分类不能绕过已存在任务。源变更、目标分类变更会拒绝，不覆盖原证据。

`clean --out` 还会向 stdout 输出完整 Source Draft。调度器直接将 stdout/stderr 写入当前私有任务目录的 `clean.stdout.log`、`clean.stderr.log`，避免复杂流程超过内存管道缓冲上限。`clean.command.json` 保存退出码、信号、错误码、耗时、输出文件是否存在及日志字节数。只有命令成功且产物可解析、源身份有效才入队；输出文件存在本身不代表成功。

导入失败后，`intake-*/intake-failure.json` 记录源路径，并通过 `cleanReport` 指向命令诊断。原始日志保存在同一目录，权限 600，不在终端自动展开业务 XML。成功导入时诊断随快照移入任务目录。旧版的 `ENOBUFS` 表示捕获输出超过 2 MiB；升级本修复后，可重新导入原 manifest，保留并跳过已有相同任务，无需删除任何失败目录或重新创建迁移身份。这只恢复离线导入，不会重放已派发任务或未知远端写入。

历史手工迁移和既有批次仍需在每个 session 开始时只读核查；本地调度队列不能自动证明外部历史不存在。所有新的并行迁移统一从本调度器领取。不要再用独立 Codex、独立 batch worker 或第二个状态目录同时处理同一范围。

## 先跑小批，再启用定时派发

timer 未启用时，可先手动派发少量任务，仍受同一全局上限控制：

```bash
mk-codex-scheduler resume
mk-codex-scheduler start --count 2
mk-codex-scheduler pause
mk-codex-scheduler status
mk-codex-scheduler list
```

`pause` 只停止领取，不停止两个已运行的 session。它们由独立 systemd transient service 托管，堡垒机终端断开不影响运行，调度器进程退出也不会终止它们。先核对这几个任务真实完成、内存和耗时，再启用自动运行：

```bash
mk-codex-scheduler resume
systemctl enable --now mk-codex-scheduler.timer
systemctl list-timers mk-codex-scheduler.timer
```

额外手动任务使用 `start --count N` 或 `start --count 1 --task 实际任务ID`。队列暂停时不派发，非 queued 项不会重跑。定时和手动调用通过同一内核文件锁串行领取；忙时退出码 75 表示本次没有派发。

## 查看、调参和暂停

```bash
mk-codex-scheduler status
mk-codex-scheduler list --status outcome_unknown
mk-codex-scheduler list --status needs_repair
mk-codex-scheduler list --out /var/lib/mk-migrate/task-status-001.json
mk-codex-scheduler item --task 实际任务ID
journalctl -u mk-codex-scheduler.service --since today
```

状态包含完成耗时样本、平均值、P95 及超过 120 分钟的长任务。单项目录保存 `task.json`、来源快照、`launch-intent.json`、固定运行配置、Codex JSONL 事件、stderr、最终答复、进程结果、会话 ID、外层 Codex token 用量及执行产物。`agent-review` 模型用量需另结合其报告/服务商统计，不能用外层 usage 代表全部用量。日志和产物均私有，不自动删除。

配置文件为 `/etc/mk-migrate/codex-scheduler.json`。推荐导出完整配置，编辑副本，再原子应用，不需要暂停或重启 session：

```bash
mk-codex-scheduler config --out /etc/mk-migrate/scheduler-next-001.json
# 用服务器编辑器修改上面的副本，保留其他配置字段。
mk-codex-scheduler config-apply --file /etc/mk-migrate/scheduler-next-001.json
mk-codex-scheduler config
```

`schedule` 字段的默认值如下：

```json
{
  "weekday": [
    { "id": "weekday-day", "start": "07:00", "end": "19:00", "batchSize": 10, "intervalMinutes": 20 },
    { "id": "weekday-night", "start": "19:00", "end": "07:00", "batchSize": 20, "intervalMinutes": 15 }
  ],
  "weekend": [
    { "id": "weekend", "start": "00:00", "end": "24:00", "batchSize": 20, "intervalMinutes": 15 }
  ]
}
```

每类日期最多 24 个窗口。起点包含、终点不包含；终点早于起点表示跨午夜，以最近的起点计算间隔。整天使用 `00:00`–`24:00`，起止相同会拒绝。日类型按当日星期判断；周末窗口在周六 00:00 起覆盖工作日策略。间隔可为 1–1440 分钟，不要求整除一小时，例如 `21:10` 起每 17 分钟派发。窗口之间允许空档，空档不自动派发；重叠、非法时间、重复 id 和非法数量会拒绝，原配置保持不变。

同样可以调整 `maxSessions`、内存/磁盘余量、预计单任务内存、长任务阈值和最多 0–3 次本地修复预算（默认 2）。每次派发读取当前配置；新任务保存新快照，已有任务快照不改，降低上限只等待自然回落。同一分钟已经消费过的时隙，不会因改配置再次派发，也不会补发旧时隙。`config-apply` 不允许切换状态目录、程序路径或 skill 路径；这些安装级参数不能用来绕过历史任务。

## 每 60 秒采样与历史

`mk-codex-sampler.timer` 独立于派发 timer，使用独立文件锁。即使队列暂停、处于窗口空档、无待办任务或派发锁正在导入大清单，也会每分钟采样。系统负载可造成采样延迟，离线时不会生成虚假的补采样。

| 范围 | 保存的指标 |
| --- | --- |
| 服务器 | CPU 使用率及 iowait、逻辑 CPU 数、1/5/15 分钟 load、总/可用/已用内存、Swap、数据盘总量/可用空间、启动标识和 uptime |
| 每个 session（含子进程） | cgroup 累计 CPU 时间与区间使用率、当前/峰值内存、Swap、任务/线程数、累计磁盘读写字节及区间速率、systemd 状态和 InvocationID |

CPU 使用率由相邻样本差值计算；首条、重启或计数器不连续时为 `null`。session 的 `cpuPercent` 以一个逻辑 CPU 满载为 100%，可超过 100%；`cpuMachinePercent` 除以整机逻辑 CPU 数，便于和服务器总量比较。`cpuUsageNSec` 是十进制字符串，避免累计纳秒值损失精度。内存按 cgroup 整组统计，包含 Codex 和迁移/审查子进程。

不同内核和 systemd 版本支持的计数器不同，缺失值记 `null`，并列入 `unavailable`，不会伪装成 0。优先读取 cgroup v2，旧系统使用可用的 systemd accounting；新 worker 开启 CPU/内存/IO/任务统计，升级前已运行的旧 worker 不重启，暂缺指标照实记录。完全发生在两个采样点之间的短 session 可能没有周期样本，仍有原有任务执行记录。采集不到 systemd 信息时保存服务器数据及明确错误标记，不修改任务状态。

历史按北京时间保存在状态目录中，每分钟一个独立文件，不覆盖或自动删除：

```text
/var/lib/mk-migrate/codex-scheduler/metrics/
  latest.json                 当前最新样本
  2026-10-11/
    1900.json                 19:00 的服务器及全部可见 session 样本
    1901.json
```

文件权限 600，目录 700。历史不包含进程命令行、环境变量、密码或模型输入输出；只保存资源计数和任务关联信息。

```bash
systemctl list-timers mk-codex-sampler.timer
mk-codex-scheduler sample
mk-codex-scheduler metrics
mk-codex-scheduler metrics --date 2026-10-11 --out /var/lib/mk-migrate/resources-20261011.json
mk-codex-scheduler metrics --date 2026-10-11 --task 实际任务ID --out /var/lib/mk-migrate/task-resources-001.json
journalctl -u mk-codex-sampler.service --since today
```

`sample` 同一分钟只保存一次；`metrics` 不采样，只读取历史。采样指标用于观察和调参，不会自动修改并发或终止 session。原有派发前内存/磁盘余量检查仍独立执行。

```bash
mk-codex-scheduler pause
systemctl disable --now mk-codex-scheduler.timer
```

停止 timer 不会停止 worker。不要 `systemctl stop mk-codex-task-*`、杀进程、重启、锁定引擎或更新引擎来暂停派发。维护前等待工作单元结束；若必须中断，保留证据并按未知写入调查。

## 成功、异常与有限修复

仅当执行报告明确成功、回读成功、迁移登记 recorded 且来源/目标匹配，才计入 `succeeded`。DSL/意图/报告摘要和源身份不匹配、意图缺回执、旧版本缺写入状态字段、异常退出无报告等进入 `outcome_unknown`。已写入但没有完整成功证据进入 `needs_repair`；无完整执行结果则 `needs_attention`。退出码 0 或模型自述不算成功。

最多两次本地 DSL/参数修复通过任务指令约束，并保留各轮证据；这不是改变远端重试规则的许可。正常新建授权不包括锁定草稿、已发布表单修复及回调补写。后者仍需原项目规定的另行范围、摘要、备份和单次写入条件，调度器不自动发起。长任务只告警，不用超时强杀正在写入的进程。

`maxAutoRepairAttempts` 控制首次执行后的自动修复轮数，默认 10，允许 0–10，0 表示禁用。这是调度器持久化执行的上限，与同一 session 内默认两次的本地修复预算分开；最多首次 session 加十个修复 session。只有 `needs_attention` 满足以下全部条件才会在下一正常派发时隙续跑：所有历史 session 已停止；每轮有正常结束记录、完整的编号执行意图/报告和匹配的 DSL 摘要；每份报告明确 `remoteWriteAttempted=false`、`writeOutcomeUnknown=false`；没有创建/更新 ID、目标、回读、登记或写 API 阶段证据。报告缺失、异常退出、未知写入、已写入或历史有任何变动均不续跑。旧任务只靠 agent-review 日志或退出码 0，不能证明没有写入，仍保留待处理。

修复沿用原任务身份、来源、目标、分类、授权和引擎版本，与新任务共享批次大小、时隙和总并发/资源限制。达到上限后仍为 `needs_attention`，`list` 中的 `autoRepair.reason` 会标记 `retry_limit_reached`；证据不足标记 `no_remote_write_not_proven`。`autoRepair.detail` 区分具体原因，例如 `execution_receipt_missing`（缺少执行回执）、`execution_evidence_changed`（回执摘要变化）、`unbound_execution_evidence`（额外执行证据没有绑定）、`stdout_receipt_mismatch`（stdout 内容不一致）、`stdout_receipt_path_mismatch`（stdout 输出路径不对应）及 `evidence_json_invalid`（JSON 无法解析）。只输出固定诊断码，不输出凭据或原始错误内容。安装后无需重新导入，已结束的旧版安全失败也会接受证据检查。暂停会同时暂停新任务和自动修复，已有 session 继续运行。

`execute-NNN.stdout.json` 和 `execution-NNN.stdout.json` 可以保留为 `execution-NNN.report.json` 的输出副本。它们必须对应同号、已校验且确认无远端写入的回执；JSON 内容需完整一致。CLI 额外输出的 `wrote` 字段只有在它是指向该回执的绝对路径时才可作为输出元数据处理。字段缺失、多出业务字段、结果不一致或路径不匹配都会阻止修复；不会仅凭 `.stdout.json` 文件名放行。所有副本仍保留并计入历史摘要。模型生成的 `blocked*.json` 等总结不能替代执行回执，没有回执仍不能自动重跑。

首次产物保留在 `tasks/<ID>/`，各轮修复位于 `tasks/<ID>/attempts/001` 至 `010`，有各自的配置、意图、DSL、日志、报告和完成记录。`repair-context.json` 保存每一轮历史目录及文件摘要，worker 启动前再次核对；Codex 先阅读历史阻塞原因，保存新的 `repair-plan.json`，只在本轮工作目录进行有依据的修复。历史证据不会移动、覆盖或清空。systemd 修复单元为 `mk-codex-task-<ID>-r1.service` 至 `-r10.service`，60 秒资源采样照常包含它们。

用 `mk-codex-scheduler item --task ID` 查看当前目录、当前完成记录和全部尝试；不要再仅靠根目录的 `completion.json` 判断最新结果。`status` 显示 `maxAutoRepairAttempts` 和已派发修复总数 `repairAttemptsUsed`。修改修复预算仍通过 `config-apply`，只影响后续派发，不能把累计次数清零。已经设置为 5 的服务器升级后保留 5，需要显式将 `maxAutoRepairAttempts` 改为 10 并执行 `config-apply`；已用五轮且仍符合安全条件的任务可以从第六轮继续，最多到第十轮。

没有 reset 或绕过证据的重跑命令。中断的派发保留意图并计入已占用轮次，不重新启动同一轮；缺失完成证据时停止续跑。不得删除任务目录、状态库、写入意图或永久防重试锁来恢复容量。同一批任务始终使用同一状态目录。已写入任务及登记结果未知的任务不属于自动修复范围。

## 验证边界

仓库 route-validation 测试使用可控时钟、资源计数 fixture、假 Codex 进程和假服务管理器，覆盖可配置时段、运行中配置更新、历史采样与缺失值、领取、容量、异常保留及报告验收；默认不调用真实模型和 NewOA。`node scripts/codex-scheduler-linux-smoke.mjs` 在禁用网络的 Node 22 Linux 容器中验证完整安装、CLI、真实 flock、真实 Linux 主机计数、独立采样及运行中升级；设置 `MK_SCHEDULER_LEGACY_ARCHIVE` 为上一版压缩包路径可验证跨版本升级。session 计数和 systemd 管理器使用替身。真实 systemd 服务管理、目标机 Codex 认证/沙箱及真实迁移吞吐量仍需要按服务器小批验证。安装部署包不更新加密引擎。

调度器使用 systemd 独立 transient service 托管 session，其机制参见 [systemd 249 官方说明](https://github.com/systemd/systemd/blob/v249/man/systemd-run.xml)。Codex 使用 `exec --json` 的非交互模式，参见 [OpenAI 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)。
资源统计依据 [systemd accounting](https://github.com/systemd/systemd/blob/v249/man/systemd.resource-control.xml) 和 [Linux cgroup v2 计数器](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)。
