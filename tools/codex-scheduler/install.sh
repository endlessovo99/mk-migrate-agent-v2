#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo '请以运行 mk-migrate-secure 的 root 账号安装。' >&2; exit 1; }
test "$(uname -s)" = Linux
MK_SCHEDULER_NODE="$(command -v node)"
MK_SCHEDULER_CODEX="$(command -v codex)"
command -v flock >/dev/null
command -v systemd-run >/dev/null
command -v mk-migrate-secure >/dev/null
MK_SCHEDULER_SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$MK_SCHEDULER_SOURCE"
sha256sum -c MANIFEST.sha256
"$MK_SCHEDULER_NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
# Serialize upgrades with admission/config changes, but leave worker and sampler units alone.
MK_SCHEDULER_STATE="$("$MK_SCHEDULER_NODE" --input-type=module - "$MK_SCHEDULER_SOURCE" <<'NODE'
import { existsSync } from 'node:fs';
const { loadConfig, DEFAULTS } = await import(process.argv[2] + '/common.mjs');
const path = '/etc/mk-migrate/codex-scheduler.json';
console.log(existsSync(path) ? loadConfig(path).stateDir : DEFAULTS.stateDir);
NODE
)"
install -d -m 700 "$MK_SCHEDULER_STATE"
if [ "${MK_SCHEDULER_INSTALL_LOCKED:-}" != 1 ]; then
  exec flock --nonblock --conflict-exit-code 75 --close "$MK_SCHEDULER_STATE/control.lock" \
    env MK_SCHEDULER_INSTALL_LOCKED=1 sh "$MK_SCHEDULER_SOURCE/install.sh"
fi
"$MK_SCHEDULER_NODE" --input-type=module - "$MK_SCHEDULER_STATE" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
const path = process.argv[2] + '/state.json';
if (existsSync(path) && JSON.parse(readFileSync(path)).paused !== true) {
  console.error('先执行 mk-codex-scheduler pause；已有 session 不需要停止。'); process.exit(1);
}
NODE
install -d -m 700 /opt/mk-migrate /etc/mk-migrate
MK_SCHEDULER_DEST="$(mktemp -d /opt/mk-migrate/codex-scheduler-XXXXXXXX)"
cp -R "$MK_SCHEDULER_SOURCE/." "$MK_SCHEDULER_DEST/"
chmod -R go-rwx "$MK_SCHEDULER_DEST"
if [ ! -f /etc/mk-migrate/codex-scheduler.json ]; then
  "$MK_SCHEDULER_NODE" --input-type=module - "$MK_SCHEDULER_DEST" "$MK_SCHEDULER_CODEX" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(`${process.argv[2]}/config.example.json`));
config.codexCommand = process.argv[3];
writeFileSync('/etc/mk-migrate/codex-scheduler.json', JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
NODE
fi
"$MK_SCHEDULER_NODE" --input-type=module - "$MK_SCHEDULER_DEST" <<'NODE'
const root = process.argv[2];
const { loadConfig, readJson, writeJson } = await import(root + '/common.mjs');
const path = '/etc/mk-migrate/codex-scheduler.json';
const original = readJson(path);
writeJson(root + '/previous-config.json', original, { exclusive: true });
const config = loadConfig(path);
const updated = { ...original };
for (const key of ['schedule', 'maxAutoRepairAttempts']) if (!Object.hasOwn(updated, key)) updated[key] = config[key];
writeJson(path, updated);
NODE
if [ ! -f /etc/mk-migrate/codex-scheduler.env ]; then
  # systemd workers do not inherit an interactive shell's PATH or provider variables.
  (umask 077; printf 'PATH=%s:%s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n' \
    "$(dirname -- "$MK_SCHEDULER_NODE")" "$(dirname -- "$MK_SCHEDULER_CODEX")" > /etc/mk-migrate/codex-scheduler.env)
fi
test -f /root/.agents/skills/mk-migrate-server/SKILL.md || {
  install -d -m 700 /root/.agents/skills
  test ! -e /root/.agents/skills/mk-migrate-server
  cp -R "$MK_SCHEDULER_DEST/mk-migrate-server" /root/.agents/skills/mk-migrate-server
}
"$MK_SCHEDULER_NODE" --input-type=module - "$MK_SCHEDULER_NODE" "$MK_SCHEDULER_DEST" <<'NODE'
import { writeFileSync, renameSync } from 'node:fs';
const [node, root] = process.argv.slice(2);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const temporary = '/usr/local/bin/mk-codex-scheduler.' + process.pid + '.tmp';
writeFileSync(temporary, `#!/bin/sh\nexec env -u NODE_OPTIONS -u NODE_COMPILE_CACHE -u NODE_V8_COVERAGE ${quote(node)} ${quote(root + '/cli.mjs')} "$@"\n`, { flag: 'wx', mode: 0o700 });
renameSync(temporary, '/usr/local/bin/mk-codex-scheduler');
NODE
cat > /etc/systemd/system/mk-codex-scheduler.service <<'UNIT'
[Unit]
Description=Dispatch authorized single-flow Codex migration sessions
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
UMask=0077
Environment=HOME=/root
EnvironmentFile=-/etc/mk-migrate/codex-scheduler.env
ExecStart=/usr/local/bin/mk-codex-scheduler tick
SuccessExitStatus=75
TimeoutStartSec=infinity
UNIT
cat > /etc/systemd/system/mk-codex-scheduler.timer <<'UNIT'
[Unit]
Description=Check Codex migration admission slots every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Persistent=false
Unit=mk-codex-scheduler.service

[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/mk-codex-sampler.service <<'UNIT'
[Unit]
Description=Save host and Codex session resource samples

[Service]
Type=oneshot
User=root
UMask=0077
Environment=HOME=/root
EnvironmentFile=-/etc/mk-migrate/codex-scheduler.env
ExecStart=/usr/local/bin/mk-codex-scheduler sample
SuccessExitStatus=75
TimeoutStartSec=55
UNIT
cat > /etc/systemd/system/mk-codex-sampler.timer <<'UNIT'
[Unit]
Description=Sample migration server resources every 60 seconds

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Persistent=false
Unit=mk-codex-sampler.service

[Install]
WantedBy=timers.target
UNIT
"$MK_SCHEDULER_NODE" "$MK_SCHEDULER_DEST/cli.mjs" --locked init >/dev/null
systemctl daemon-reload
systemctl enable --now mk-codex-sampler.timer
printf '安装目录：%s\n配置：/etc/mk-migrate/codex-scheduler.json\n队列保持暂停；首次安装不启用派发 timer。60 秒采样 timer 已启用，已有 session 继续运行。\n' "$MK_SCHEDULER_DEST"
