# 堡垒机客户端：通过文件交接解锁

适用于本机无法直接使用 SSH、只能通过堡垒机客户端执行命令及上传下载文件的环境。现有 `engine.mkpkg.age` 和本机项目私钥可以继续使用，只需更新通用启动器及本机工具。

项目私钥始终由本机生成。服务器额外生成一对只用于本次交接的临时接收密钥，临时私钥仅保存在 `/run/mk-migrate/engine/` 的 tmpfs 中。下载的请求文件只包含公钥和摘要；上传的授权文件是加密后的私钥及回执验证材料，不是明文私钥。项目运行后的源码保密边界与原方案相同，文件备份仍必须排除整个 tmpfs 运行目录，包括等待授权期间。

`prepare-unlock`、`unlock-ticket` 和 `lock` 必须在普通堡垒机终端执行。Codex 沙箱可能通过 bind mount 暴露同一路径的多个挂载条目；新版启动器允许 `status`、`run` 识别当前进程实际可见的 tmpfs，但拒绝在叠加挂载环境中解锁或锁定。更换运行包前等待任务结束并退出旧 Codex 会话，再从普通终端切换；不要直接导入引擎绕过启动器。

## 1. 更新服务器启动器

如果使用本次补丁，把补丁 `upload/launcher/` 中的所有文件上传到服务器已有的：

```text
/opt/mk-migrate/releases/release-001/upload/launcher/
```

只上传公共启动器文件，不上传原发布目录的 `private/`。上传后，在堡垒机终端执行：

```bash
mk-migrate-secure status
```

状态为 `locked` 时，安装新启动器：

```bash
cd /opt/mk-migrate/releases/release-001/upload
install -m 600 launcher/*.mjs /opt/mk-migrate/launcher/
install -m 700 launcher/mk-migrate-secure /usr/local/bin/mk-migrate-secure
mk-migrate-secure status
```

如果已经解锁或处于待授权状态，先等待业务任务结束并成功执行 `mk-migrate-secure lock`，再安装。新生成的发布包已经包含文件交接工具。

## 2. 服务器生成公开请求

服务器执行下面的命令。这里的 SHA-256 必须使用本机 `release.json` 中本次发布包的值；它是公开摘要，不是私钥。

```bash
mk-migrate-secure prepare-unlock \
  --package /opt/mk-migrate/releases/release-001/upload/engine.mkpkg.age \
  --sha256 '本机release.json中的sha256值' \
  --request-out /opt/mk-migrate/releases/release-001/upload/unlock-request-001.json
```

输出应包含 `status: awaiting-ticket`、`requestSha256` 和 `expiresAt`。项目此时还不能运行。临时会话从生成起有效 30 分钟，需要在到期前完成第 3～4 步；它不限制已成功解锁后的运行时长。

使用堡垒机文件通道，将 `unlock-request-001.json` 下载到 Mac 的 `Downloads`。同时从可信堡垒机终端复制输出的 `requestSha256`，用于防止下载的公钥请求被替换。这个摘要可以公开，不能省略核对。

## 3. Mac 生成密文授权文件

先设置原发布目录和本机工具目录。使用补丁时，`mk_local_tools` 指向补丁目录里的 `local-tool`；使用新发布包时，指向该发布包自己的 `local-tool`。

```bash
mk_release_dir="/Users/endlessovo/Downloads/mk-migrate-secure-20261010-12be94"
mk_local_tools="补丁目录的绝对路径/local-tool"

node "$mk_local_tools/offline-local.mjs" authorize \
  --release "$mk_release_dir" \
  --request "$HOME/Downloads/unlock-request-001.json" \
  --request-sha256 '从堡垒机终端复制的requestSha256'
```

命令输出 `ticketFile`，这是本次需要上传的密文文件路径，例如 `upload/unlock-ticket-一串编号.age`。本机私钥此时保留，不会删除。

只将这个密文文件上传到服务器，并将服务器端文件名设为：

```text
/opt/mk-migrate/releases/release-001/upload/unlock-ticket.age
```

不要上传 `private/unlock.key` 或 `private/offline-*.json`；不要将它们粘贴到堡垒机终端。不要通过聊天发送这些文件。

## 4. 服务器接收授权并解锁

服务器执行：

```bash
mk-migrate-secure unlock-ticket \
  --ticket /opt/mk-migrate/releases/release-001/upload/unlock-ticket.age \
  --receipt-out /opt/mk-migrate/releases/release-001/upload/unlock-receipt-001.json

mk-migrate-secure status
```

成功后显示 `status: unlocked`。服务器会销毁本次临时接收密钥，校验项目、安装依赖，并把代码目录设为只读。旧授权不能解锁新的会话，也不能在锁定后重新激活项目。

如果解锁失败或结果不明，先查看 `status`。若已解锁但回执下载失败，可用下面的命令重新导出相同回执，不必重新解锁：

```bash
mk-migrate-secure status > /opt/mk-migrate/releases/release-001/upload/unlock-receipt-recovered.json
```

如果为 `locked`，或者等待授权已过期，保留原发布包和本机私钥，重新准备新请求即可；过期但仍挂载时先 `lock`。请求和回执输出文件不得覆盖旧文件，请将文件名的 `001` 改成新的编号。错误授权会终止当前临时会话，不会自动重试，也不会调用 NewOA。

## 5. 下载回执，在 Mac 完成密钥清理

将 `unlock-receipt-001.json` 下载到 Mac 的 `Downloads`，然后本机执行：

```bash
node "$mk_local_tools/offline-local.mjs" complete \
  --release "$mk_release_dir" \
  --receipt "$HOME/Downloads/unlock-receipt-001.json"
```

本机核对发布版本、摘要、会话和回执认证信息后，保存成功回执，删除项目私钥及本次回执验证秘密，输出 `localKeyRemoved: true`。假回执、不匹配的回执、被更换的本机私钥都不会触发删除。

完成后，按照[主操作手册](encrypted-release.md)第 6～7 步使用 `mk-migrate-secure run -- ...` 执行任务，结束后 `mk-migrate-secure lock`。XML、DSL、执行记录和永久防重试锁仍然保留。

## 验证

默认测试使用临时密钥和假客户端，不连接真实 NewOA：

```bash
node --test tests/route-validation/secure-release*.test.js
```

真实文件交接集成测试只能在一次性 Linux root 容器或虚拟机中运行，需要 age、npm、tmpfs 挂载权限，不需要 SSH：

```bash
MK_SECURE_LINUX_SMOKE=1 node scripts/secure-release-offline-smoke.mjs
```

加密交接复用 [age 的公钥加密](https://github.com/FiloSottile/age)，没有新增外部授权服务或网络监听端口。
