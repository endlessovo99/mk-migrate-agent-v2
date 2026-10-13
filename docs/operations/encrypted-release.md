# 项目本体加密发布操作手册

本方案加密迁移工具的实现，XML 输入和 DSL 输出保持明文。解锁后的项目运行在 Linux `tmpfs` 中；发布包、业务文件、配置和执行记录各自独立存放。

## 使用约定

- 本机需要 Node.js 20 或以上及 `age`；服务器需要 Linux、root、Node.js 20 或以上、npm、`age`、`mount`、`findmnt` 和 `flock`。Node/npm 和第三方依赖在服务器直接安装，不从开发机复制。
- 如果只能通过堡垒机客户端打开终端和传文件，使用[堡垒机文件交接步骤](encrypted-release-bastion.md)，无需本机 SSH 直连。项目私钥仍在本机生成，不上传明文私钥。
- SSH 解锁助手需要不分配终端的 SSH 标准输入通道，以及已经配置好的 SSH 密钥登录，支持 `~/.ssh/config` 中的 `ProxyJump`。下面第 5 步仅适用于这种连接方式。
- 一次解锁可连续运行多个 CLI 命令。解锁成功后删除本机私钥文件，退出 SSH 不会自动锁定。显式锁定或服务器重启后，需要新密钥和新发布包。
- “一次性”表示工具保存成功回执后删除私钥文件，并拒绝再次使用这份本地发布记录；复制过的私钥仍然能解密原包。删除文件不等于抹除 SSD、快照或备份中的副本。不要把 `private/` 加入本机备份。
- 这版不修改 swap、休眠和系统转储配置，也不防运行期间的其他 root 用户或包含内存的虚拟机快照。常规文件备份必须排除整个运行内存目录；不能把这一版理解为已经覆盖全部系统级落盘途径。
- 已经上传过的明文源码或历史备份不在本次加密工具的清理范围。

## 1. 本机：安装工具并打包

macOS 本机执行：

```bash
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install age
node --version
age --version

cd /Users/endlessovo/onewo/ai/mk-migrate-agent-v2
mk_release_dir="$HOME/Downloads/mk-migrate-secure-$(date +%Y%m%d-%H%M%S)"
node tools/secure-release/package.mjs --out "$mk_release_dir"
```

输出目录必须是仓库之外、尚不存在的新目录。打包只读取当前文件，不修改 Git 或已有工作区变更。包内记录当前提交和是否包含工作区快照；有未提交修改时，不会将其标记为干净提交发布。

输出结构：

```text
本次发布目录/
  upload/                    ← 只上传这个目录里的内容
    engine.mkpkg.age          ← 项目本体密文
    engine.mkpkg.age.sha256
    launcher/                ← 通用解锁和启动工具，无迁移业务实现
  private/
    unlock.key               ← 留在本机，权限 600
  local-tool/
    unlock-local.mjs
    common.mjs
  release.json               ← 本机核对解锁回执的版本和摘要
```

`.mkpkg.age` 是 age 加密的 gzip/JSON 文件包，不是 tar 文件，不要使用 `tar -xf`。文件包仅接受 `src/`、`catalogs/`、`package.json` 和 `package-lock.json` 中允许的运行文件；包含文件摘要，并拒绝软链接、重复路径和路径穿越。XML、DSL、`.tmp`、`.git`、测试及运行凭据不在包中。

## 2. 服务器：安装基础工具

通过堡垒机登录服务器，以 root 执行：

```bash
apt-get update
apt-get install -y age util-linux
node --version
npm --version
age --version
command -v mount findmnt flock

install -d -m 700 /opt/mk-migrate/releases
install -d -m 700 /opt/mk-migrate/launcher
install -d -m 700 /var/lib/mk-migrate/input
install -d -m 700 /var/lib/mk-migrate/dsl
install -d -m 700 /var/lib/mk-migrate/reports
install -d -m 700 /etc/mk-migrate
```

如果 Node/npm 尚未安装，先按[受限 Ubuntu 部署指南](restricted-ubuntu22-setup.md)安装基础运行时。不要再上传或解压旧的明文项目源码包。

## 3. 本机上传，服务器安装启动器

为本次发布选择一个新目录，例如 `/opt/mk-migrate/releases/release-001/`。使用现有 SFTP/FileZilla，只把本机 `upload/` **里面的文件和 `launcher/` 子目录**上传到这个目录。不要上传发布目录的其他部分。

服务器执行：

```bash
cd /opt/mk-migrate/releases/release-001
sha256sum -c engine.mkpkg.age.sha256

install -m 600 launcher/*.mjs /opt/mk-migrate/launcher/
install -m 700 launcher/mk-migrate-secure /usr/local/bin/mk-migrate-secure
mk-migrate-secure status
```

首次安装的状态应为 `locked`。更新启动器之前，应先停止新任务并成功执行 `mk-migrate-secure lock`。运行期间不要覆盖启动器或修改控制锁文件。

## 4. 服务器：单独配置账号和输入文件

```bash
touch /etc/mk-migrate/newoa.env
chmod 600 /etc/mk-migrate/newoa.env
```

使用你的安全配置方式填写现有项目需要的 NewOA、模型、checkpoint 和数据库环境变量；不要把凭据放进发布包或操作记录。启动器复用项目的 dotenv 加载逻辑，已经导出的环境变量仍优先于文件内容。配置文件必须由 root 所有且不允许组和其他用户访问。

将 XML 或成对 XML 目录上传到 `/var/lib/mk-migrate/input/`。已有可信 DSL 可直接放入 `/var/lib/mk-migrate/dsl/`。

## 5. 本机：通过 SSH 解锁

仅支持堡垒机客户端的环境，请改用[文件交接步骤](encrypted-release-bastion.md)，完成后继续本页第 6 步。

先确认你已核验目标主机指纹，并将目标配置为 SSH 别名，例如 `mk-migrate-server`。跳板连接在本机 `~/.ssh/config` 配置，目标最终登录用户为 root。不要关闭主机指纹检查。

本机先检查通道：

```bash
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes mk-migrate-server 'id -u; node --version'
```

应显示目标服务器用户 ID 为 `0`，并能找到 Node。然后本机执行：

```bash
node "$mk_release_dir/local-tool/unlock-local.mjs" \
  --release "$mk_release_dir" \
  --host mk-migrate-server \
  --remote-package /opt/mk-migrate/releases/release-001/engine.mkpkg.age
```

换了本机终端时，先将 `mk_release_dir` 设置为本次实际发布目录的绝对路径。

解锁助手将私钥通过 SSH 标准输入传给服务器，不使用伪终端，不把私钥写入服务器文件。服务器会挂载专用 tmpfs、核对密文摘要、解密并校验全部文件、直接安装锁文件指定的第三方依赖，再将 tmpfs 改为只读。只有全部成功才返回 `unlocked` 回执。默认 npm 源为 `https://registry.npmmirror.com`，仍需允许锁文件中依赖实际使用的下载地址。

本机收到匹配的 `releaseId` 和 SHA-256 后，保存 `unlock-receipt.json`，删除 `private/unlock.key`，并输出 `localKeyRemoved: true`。SSH 断线、结果不明、回执不匹配时不会删除密钥，也不会自动重试。此时先到服务器执行 `mk-migrate-secure status`；若已解锁且版本匹配，可继续使用，并在本机确认后删除对应私钥文件。不要再次发送解锁命令，也不要把状态查询当作重新执行迁移的理由。

解锁失败会尝试卸载本次 tmpfs。若提示清理失败，检查状态并使用 `lock` 清理；不要在普通硬盘目录手工解压作为替代。

## 6. 服务器：运行现有命令

使用 `mk-migrate-secure run --` 加原来的 CLI 参数。相对路径从 `/var/lib/mk-migrate/` 解析；也可以传入原有磁盘文件的绝对路径。CLI 退出码会保留。

```bash
mk-migrate-secure run -- clean input/原流程目录 \
  --out dsl/source-draft.json

mk-migrate-secure run -- draft dsl/source-draft.json \
  --out dsl/dsl-draft.json

mk-migrate-secure run -- check draft dsl/dsl-draft.json

mk-migrate-secure run -- agent-review dsl/source-draft.json dsl/dsl-draft.json \
  --out dsl/migration.dsl.json \
  --report-out reports/agent-review.report.json \
  --checkpoint-out reports/agent-review.checkpoint.json

mk-migrate-secure run -- check trust dsl/source-draft.json dsl/migration.dsl.json
mk-migrate-secure run -- check execute dsl/migration.dsl.json
mk-migrate-secure run -- dry-run dsl/migration.dsl.json \
  --out reports/dry-run.report.json
```

`agent-review` 会调用配置的真实模型，但上述步骤不会创建 NewOA 模板。在[服务器 Codex 操作约定](codex-cli-migration.md)下，用户明确要求迁移指定范围、目标和分类时，该任务就是正常新建草稿的写入授权；Agent 完成检查后直接传入 `--confirm-write`，不再追加一轮人工确认。只翻译、检查或预演的任务不执行下面命令。兜底已配置时按 skill 选择对应开关：

```bash
mk-migrate-secure run -- execute dsl/migration.dsl.json \
  --confirm-write \
  --target-category-id '实际分类fdId'
```

批处理和修复命令同样通过 `run --` 调用。普通批次可依据真实迁移任务和当前方案由 Agent 登记内部审批；已有模板的特殊修复不包含在普通迁移授权内，其确认、快照摘要、私有证据和未知写入禁止重试等规则保留。更新引擎版本后仍须通过既有摘要检查和 reprepare 流程，不能直接重放任务。skill 分开安装到 Codex 账号的技能目录，不放进 `/run/mk-migrate/engine/`；安装方式见上述服务器操作指南。

## 7. 服务器：结束使用并锁定

```bash
mk-migrate-secure status
mk-migrate-secure lock
mk-migrate-secure status
```

如果还有通过启动器运行的 CLI，`lock` 返回退出码 `75`，不会中断迁移。先停止提交新任务，等待已有命令结束，再锁定。不要强制杀死执行中的迁移进程来完成锁定。

成功锁定会卸载 tmpfs。XML、DSL、配置、报告、数据库和永久防重试锁保留；再次 `run` 会被拒绝。下一次使用从本机生成新发布包开始，无需删除旧业务文件。

## 备份范围

可备份加密发布目录，以及 `/var/lib/mk-migrate/` 中的明文业务文件。凭据配置按原有保密策略管理。还必须保留 PostgreSQL 批处理数据库，以及执行用户的永久锁目录；root 用户通常是 `/root/.codex/mk-migrate-agent-v2/locked-draft-locks/`。如果 root 账号的 home 不是 `/root`，按该账号实际 home 核对，不能为了恢复任务而更换 home 或删除锁。

文件级备份必须排除 `/run/mk-migrate/engine/` 及任何自定义的 `--runtime` 目录。备份恢复后，只有 XML、DSL、回执、永久锁和加密包；解锁前不能运行项目。不要用过期的执行记录、数据库或锁覆盖更新状态，外部写入结果不明时按现有流程调查，不得重放。

## 验证命令

本机离线测试（需要本机已有 `node_modules`；安装 age 后才会运行真实密码学测试）：

```bash
node --test tests/route-validation/secure-release.test.js \
  tests/route-validation/secure-release-unlock.test.js
```

Linux 集成测试仅在一次性的、允许挂载 tmpfs 的 Linux root 容器或虚拟机中运行，不能拿业务服务器作为试验环境。它会安装依赖、生成测试密钥、使用假模型和假 NewOA，不会访问真实 NewOA：

```bash
MK_SECURE_LINUX_SMOKE=1 node scripts/secure-release-linux-smoke.mjs
```

若同时配置 `MK_SECURE_SSH_HOST`，该 SSH 别名必须指向同一个一次性测试环境且共享相同绝对路径；集成测试会进一步验证真实 SSH 解锁与本机私钥删除。

外部参考：[age](https://github.com/FiloSottile/age)、[Linux tmpfs](https://docs.kernel.org/filesystems/tmpfs.html)。
