# Ubuntu 22.04 受限环境部署指南

适用项目：`mk-migrate-agent-v2`

更新日期：2026 年 10 月 9 日

**所有命令都在部署机器上执行。** 通过堡垒机 SSH 登录 Ubuntu 22.04 后，从获准的境内镜像直接下载 Node.js、npm、Codex CLI 和项目依赖，再连接内网 DeepSeek 服务。

npm 随 Node.js 发行包一起安装，不需要单独下载。软件安装完成后，验证步骤止于 AI 审查和 dry-run，不会创建或修改 NewOA 模板。

## 执行顺序

| 顺序 | 操作 | 完成标志 |
| --- | --- | --- |
| [1](#1-安装基础软件) | 安装 curl、Git 等系统软件 | 基础命令可用 |
| [2](#2-直接下载-nodejs-和-npm) | 从境内镜像下载 Node.js 发行包 | `node --version`、`npm --version` 成功 |
| [3](#3-通过-npm-直接安装-codex-cli) | npm 直接下载并安装 Codex CLI | `codex --version` 成功 |
| [4](#4-在项目目录下载-npm-依赖) | 在部署机执行 `npm ci` | 依赖安装成功，本地测试结果已检查 |
| [5](#5-配置内网模型和项目) | 填写模型地址、model ID 和 API Key | 项目配置就绪 |
| [6](#6-配置并验证-codex) | 连接内网模型并测试工具调用 | 工具真实执行并返回结果 |
| [7](#7-验证项目审查和-dry-run) | 运行仓库内置样例 | 审查、可信 DSL 校验和 dry-run 成功 |

逐段执行，上一段失败时先处理错误。中文占位符需要替换；命令使用 Bash。第 5～7 步保持同一会话，以保留 API Key 环境变量。

## 先申请部署机的网络访问

### 公网软件下载

向网络团队申请部署机到以下域名的出站 TCP 443：

| 域名 | 用途 |
| --- | --- |
| `registry.npmmirror.com` | npm 元数据、项目依赖、Codex、Node.js 下载入口 |
| `cdn.npmmirror.com` | 文件重定向后的实际下载地址，必须同时考虑 |
| `mirrors.tuna.tsinghua.edu.cn` | Ubuntu 软件包；已有内网 APT 源则使用内网源 |

2026 年 10 月 9 日核验的固定版本 Codex 包及 Node.js 校验文件均从 registry 跳转到 CDN。网络团队需确认部署机实际解析、重定向和境内节点归属。如果只能申请固定 IP，由网络团队提供符合要求的境内软件仓库或受控下载出口，仍由部署机直接下载。

### 内网业务访问

| 目标 | 用途 |
| --- | --- |
| 自部署 DeepSeek API 地址及端口 | 项目审查和 Codex 推理 |
| NewOA 根地址及端口 | 登录、组织查询、模板读写及 `/web/` 下的运行时校验资源 |
| `oadev.shanghai-electric.com:80` | 正常迁移完成后的固定记录回调 |
| PostgreSQL 地址及端口 | 仅批量迁移需要，通常为 TCP 5432 |
| 企业 DNS 和时间服务 | 使用运维提供的内网服务 |
| 内网 Git 仓库地址及端口 | 如需从内网仓库获取项目源码 |

当前迁移记录回调固定为 `http://oadev.shanghai-electric.com/data/sys-transfer/transferRecord/add`，修改 `NEWOA_BASE_URL` 不会改变它。真实迁移前必须确认该地址及其固定任务配置适用于目标环境。

## 1 安装基础软件

**执行位置：部署机，通过堡垒机 SSH 登录。**

APT 先由运维指向批准的 Ubuntu 22.04 `jammy` 镜像或内网源，并覆盖所需的安全更新。以下基础软件安装需要 sudo 权限；后面的 Node.js 和 Codex 安装使用当前账号，不需要 sudo。

```bash
cat /etc/os-release
uname -m

sudo apt-get update
sudo apt-get install -y \
  ca-certificates curl xz-utils tar \
  git ripgrep bubblewrap tmux openssl nano
```

## 2 直接下载 Node.js 和 npm

**执行位置：部署机。**

以下固定使用 Node.js `24.21.0`。这是版本示例，不代表自动选择最新版本；需要调整时修改 `NODE_VERSION`，并在投用前完成验收。下载命令会自动选择部署机的 `x64` 或 `arm64` 架构。

```bash
bash
set -euo pipefail
umask 077

NODE_VERSION=24.21.0

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "不支持的 CPU 架构"; exit 1 ;;
esac

NODE_NAME="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_HOME="$HOME/.local/opt/$NODE_NAME"
NODE_MIRROR="https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}"
DOWNLOAD_DIR="$(mktemp -d)"

# 已安装这个版本时停止，避免覆盖
# 如果之前已完成本步骤，直接使用文末的日常启动命令
if [ -e "$NODE_HOME" ]; then
  echo "该版本目录已存在：$NODE_HOME"
  exit 1
fi

mkdir -p "$HOME/.local/opt" "$HOME/.local/bin" "$HOME/.config/mk-migrate"
cd "$DOWNLOAD_DIR"

curl -fL "$NODE_MIRROR/$NODE_NAME.tar.xz" -o "$NODE_NAME.tar.xz"
curl -fL "$NODE_MIRROR/SHASUMS256.txt" -o SHASUMS256.txt

sha256sum --check --ignore-missing SHASUMS256.txt

tar -xJf "$NODE_NAME.tar.xz" -C "$HOME/.local/opt"

# 保存当前账号的启动配置，供以后登录使用
printf 'export PATH="%s/bin:$HOME/.local/bin:$PATH"\n' "$NODE_HOME" \
  > "$HOME/.config/mk-migrate/runtime.sh"

source "$HOME/.config/mk-migrate/runtime.sh"

node --version
npm --version
```

检查点：Node.js 显示 `v24.21.0`，npm 能显示版本。校验文件用于检查下载完整性，软件来源按单位的制品审核流程确认。

## 3 通过 npm 直接安装 Codex CLI

**执行位置：部署机。**

将全局 npm 工具安装到当前用户的 `~/.local`，使用境内镜像下载。以下固定使用 Codex CLI `0.159.2`；批准升级后替换版本号，不使用漂移的 `latest`。

```bash
source "$HOME/.config/mk-migrate/runtime.sh"

npm config set registry https://registry.npmmirror.com
npm config set prefix "$HOME/.local"

npm install -g @openai/codex@0.159.2 \
  --registry=https://registry.npmmirror.com \
  --include=optional \
  --ignore-scripts --no-audit --no-fund

codex --version
```

npm 会自动下载对应的 Linux 原生包。不要省略 optional dependencies。后续在第 6 步配置内网模型，不需要先执行 ChatGPT 登录流程。

## 4 在项目目录下载 npm 依赖

**执行位置：部署机。**

以下约定项目目录为 `~/apps/mk-migrate-agent-v2`。如果源码已经在部署机上，直接进入对应目录，并将后文出现的项目路径统一替换为实际路径。

如果需要从内网仓库获取源码，在部署机上执行下面这段；已有项目目录则跳过。仓库 URL 替换为实际可访问地址：

```bash
mkdir -p "$HOME/apps"

git clone 'https://内网Git地址/团队/mk-migrate-agent-v2.git' \
  "$HOME/apps/mk-migrate-agent-v2"
```

新克隆的工作副本可切换到批准交付的提交；已有工作副本有本地修改时，先保留改动并确认使用的版本，不直接执行切换：

```bash
cd "$HOME/apps/mk-migrate-agent-v2"

git status --short

git checkout --detach '批准交付的commit-SHA'
git rev-parse HEAD
```

直接从部署机下载项目依赖并检查本地测试：

```bash
source "$HOME/.config/mk-migrate/runtime.sh"
cd "$HOME/apps/mk-migrate-agent-v2"

npm ci \
  --registry=https://registry.npmmirror.com \
  --ignore-scripts --no-audit --no-fund

npm test
```

项目默认测试使用 fake clients，不访问 NewOA。测试失败时先确认原因，安装成功不等于项目验收通过。

当前项目锁文件使用 npmmirror 地址。改用内网制品库时，需要处理锁文件中的下载地址并保留版本和完整性校验；仅修改 npm registry 配置未必能改变所有下载目标。

## 5 配置内网模型和项目

**执行位置：部署机。模型平台确认 Responses 支持后再继续。**

需要平台提供自部署 DeepSeek v4.1 Flash 的 API 根地址、准确 model ID 和 API Key。项目需要 `/v1/responses` 的非流式 JSON 响应；Codex 还需要 SSE 流式响应、工具调用和工具结果回传。仅提供 `/v1/chat/completions` 时不能直接使用以下配置。

### 项目环境文件

```bash
source "$HOME/.config/mk-migrate/runtime.sh"
cd "$HOME/apps/mk-migrate-agent-v2"

umask 077
mkdir -p .tmp
touch .tmp/newoa.env
chmod 600 .tmp/newoa.env

nano .tmp/newoa.env
```

填入下列配置。已有文件时合并修改，不覆盖已有凭据或检查点密钥。

```dotenv
# 项目会自动追加 /v1/responses，这里不带 /v1
OPENAI_BASE_URL=https://模型服务地址
OPENAI_MODEL=模型平台提供的准确model-id
OPENAI_REQUEST_TIMEOUT_MS=600000

# 只填根地址，可以带端口，不带 /web 等业务路径
NEWOA_BASE_URL=https://目标NewOA地址

# 真实迁移前再配置
# NEWOA_USERNAME=迁移账号
# NEWOA_ENCRYPTED_PASSWORD=NewOA要求的加密密码

# 仅批量迁移需要
# MK_BATCH_DATABASE_URL=postgresql://账号:密码@数据库地址:5432/数据库名
```

CLI 自动加载 `.tmp/newoa.env`；已经导出的同名环境变量优先。项目文件中的模型配置不会自动成为 Codex 配置。

### 检查点密钥和 API Key

检查点密钥直接写入权限为 600 的文件，不打印到终端。恢复旧检查点必须使用原密钥，不能重新生成替换。

```bash
if ! rg -q '^AGENT_REVIEW_CHECKPOINT_KEY=' .tmp/newoa.env; then
  printf '\nAGENT_REVIEW_CHECKPOINT_KEY=%s\n' \
    "$(openssl rand -hex 32)" >> .tmp/newoa.env
fi

read -rsp '请输入模型 API Key: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
```

该 API Key 供当前 Bash 会话中的项目和 Codex 共用。重新登录或切换到其他会话时需要重新设置。

### 企业 CA 证书

仅当服务使用企业 CA 时执行；证书路径替换为运维提供的实际文件。

```bash
sudo install -m 0644 /路径/company-root-ca.crt \
  /usr/local/share/ca-certificates/company-root-ca.crt

sudo update-ca-certificates

export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
```

需要这两个证书环境变量时，新会话也要设置。不要通过关闭 TLS 校验处理证书错误。

## 6 配置并验证 Codex

**执行位置：部署机，保持第 5 步已导出 API Key 的会话。**

```bash
umask 077
mkdir -p "$HOME/.codex"
nano "$HOME/.codex/config.toml"
```

新账号使用下列配置；已有配置时合并对应字段。

```toml
model = "模型平台提供的准确model-id"
model_provider = "internal_deepseek"

approval_policy = "on-request"
sandbox_mode = "workspace-write"

web_search = "disabled"
check_for_update_on_startup = false

[analytics]
enabled = false

[feedback]
enabled = false

[model_providers.internal_deepseek]
name = "Internal DeepSeek"
base_url = "https://模型服务地址/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

**地址区别：项目 `OPENAI_BASE_URL` 不带 `/v1`；这里 Codex 的 `base_url` 带 `/v1`。** 两处都填写模型平台提供的准确 model ID。

初次验证只配置内网模型。部署机的出站白名单仍由网络层执行，不能仅依赖以上开关。

```bash
cd "$HOME/apps/mk-migrate-agent-v2"

codex exec \
  --skip-git-repo-check \
  --sandbox read-only \
  '使用终端工具运行 node --version 和 npm --version，报告实际结果。不要读取凭据文件，不要修改文件，不要访问业务系统。'
```

检查点：看到终端工具真实执行、返回版本，模型接收工具结果后完成回答。只有一段普通文本回答不能证明工具调用链路成功。

## 7 验证项目审查和 dry-run

**执行位置：部署机，保持模型凭据环境变量有效。**

使用仓库内置 fixture。以下命令会调用内网模型并生成本地文件，不写入 NewOA。AI 审查失败或未生成可信 DSL 时停止，检查审查报告。

```bash
cd "$HOME/apps/mk-migrate-agent-v2"
set -euo pipefail

RUN_DIR="$(mktemp -d "$PWD/.tmp/preflight.XXXXXX")"

node src/cli/main.js clean \
  tests/fixtures/source/route-validation-lbpm \
  --template-name '环境验收样例' \
  --out "$RUN_DIR/source-draft.json"

node src/cli/main.js draft \
  "$RUN_DIR/source-draft.json" \
  --out "$RUN_DIR/dsl-draft.json"

node src/cli/main.js check draft \
  "$RUN_DIR/dsl-draft.json"

node src/cli/main.js agent-review \
  "$RUN_DIR/source-draft.json" \
  "$RUN_DIR/dsl-draft.json" \
  --out "$RUN_DIR/migration.dsl.json" \
  --report-out "$RUN_DIR/agent-review.report.json" \
  --checkpoint-out "$RUN_DIR/agent-review.checkpoint.json"

node src/cli/main.js check trust \
  "$RUN_DIR/source-draft.json" \
  "$RUN_DIR/migration.dsl.json"

node src/cli/main.js check execute \
  "$RUN_DIR/migration.dsl.json"

node src/cli/main.js dry-run \
  "$RUN_DIR/migration.dsl.json" \
  --out "$RUN_DIR/dry-run.report.json"

printf '验收报告目录：%s\n' "$RUN_DIR"
```

检查点：审查报告、可信 DSL 校验和 dry-run 均成功。这只证明样例的模型审查及本地执行准备通过；真实 NewOA 迁移、持久化回读和回调需要单独验证。

## 以后每次登录怎么启动

通过堡垒机 SSH 登录后，执行：

```bash
bash
source "$HOME/.config/mk-migrate/runtime.sh"
cd "$HOME/apps/mk-migrate-agent-v2"

# 使用企业 CA 时保留；不需要时省略
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

read -rsp '请输入模型 API Key: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY

codex
```

需要长时间运行时，按堡垒机运维规则使用 tmux 或任务托管。新建 tmux 会话后，在其中执行上面的环境和密钥设置。

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| npm 元数据能访问，但下载失败 | `cdn.npmmirror.com:443` 是否放行，重定向目标是否合规 |
| Codex 缺少原生包或无法执行 | 是否在部署机执行了安装、CPU 架构是否支持、optional dependencies 和 CDN 下载是否完整 |
| 安装成功但找不到 node、npm 或 codex | 执行 `source "$HOME/.config/mk-migrate/runtime.sh"`，确认当前账号与安装账号一致 |
| 模型接口 404 | 是否确实提供 Responses，是否把 `/v1` 重复拼接 |
| 模型接口 401 | 当前会话是否已导出 API Key，平台是否接受该鉴权方式 |
| Codex 能聊天但工具调用失败 | Responses 的 SSE、工具调用及工具结果回传是否完整兼容 |
| TLS 证书错误 | 企业 CA 是否安装，证书域名是否匹配，当前进程是否加载 CA |
| Codex 沙箱启动失败 | bubblewrap 与系统加固策略是否兼容，由运维处理，不直接关闭沙箱 |
| 模板已创建，但迁移记录失败 | 固定回调地址、鉴权及迁移报告；保留证据，不重新创建模板 |

## 真实迁移前的最后准备

- 确认目标 NewOA 根地址、测试分类 fdId、迁移账号及加密密码。
- 确认固定回调地址和其中的固定任务配置适用于目标环境。
- 明确授权只创建新的 `MK_TEST_` 草稿；`execute --confirm-write` 不属于前面的环境验证步骤。
- 批量迁移先准备专用 PostgreSQL 数据库或 schema，再按[批量迁移操作说明](batch-migration.md)进行准备和批准。
- 保留源码版本、模型配置、检查点密钥、执行报告和状态锁；结果不确定的写入不得自动重试。

## 参考资料

- [项目说明](../../README.md)
- [模型审查接口实现](../../src/agent-review/provider.js)
- [项目环境文件加载](../../src/default-environment.js)
- [固定迁移记录回调](../../src/executor/transfer-record.js)
- [Codex CLI 安装文档](https://learn.chatgpt.com/docs/codex/cli)
- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex Linux 沙箱说明](https://learn.chatgpt.com/docs/sandboxing)
- [npm ci 说明](https://docs.npmjs.com/cli/commands/npm-ci/)
- [npmmirror 二进制镜像说明](https://github.com/cnpm/binary-mirror-config/blob/master/README.md)
- [Ubuntu 镜像使用说明](https://mirrors.tuna.tsinghua.edu.cn/help/ubuntu/)
