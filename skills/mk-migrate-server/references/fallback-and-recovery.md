# 兜底与恢复

## 兜底是任务的既定处理规则

本服务器操作约定把“明确迁移任务 + 已配置的兜底”视为该任务内使用对应兜底的授权。不再问“是否允许兜底”，不把所有缺失身份交还用户逐个填写。先正常解析或使用已有明确映射，再让执行器按既有条件兜底；不直接修改可信 DSL 身份，不通过任意 override 绕过拒绝。

| 对象类型 | 配置变量 | 空值时引擎默认 fdId／类型 |
| --- | --- | --- |
| 人员 `8`、身份 `256` | `NEWOA_FALLBACK_PERSON_FD_ID` | `1j5e6gebgwkw1tvw1jqie81aeqnhg302viw0` / `8` |
| 机构 `1`、部门 `2`、条件组织 | `NEWOA_FALLBACK_ORGANIZATION_FD_ID` | `1jt85rk85w23welrpw2s3uh4pvsr8ru35dw0` / `2` |
| 群组 `16` | `NEWOA_FALLBACK_GROUP_FD_ID` | `1jt85gq4uw23well7w25q9bmdj729u82tmw0` / `16` |
| 岗位 `4`、公共岗位 `128` | `NEWOA_FALLBACK_POST_FD_ID` | `1jt85eh5hw23welj9w3jq4nba1522lpc3tw0` / `4` |
| 角色线 `32` | `NEWOA_ROLELINEBACK_FD_ID` | 无默认；未配置时阻塞，不能换成人员 |

实际类型以源证据和可信 DSL 为准，“总经理”“公司领导”等名字不能证明是人员、岗位还是角色线。环境变量覆盖值优先于内置默认。内置自动兜底仍由工具正常处理；额外开关按用户已配置的对应类型和既定任务范围选择。所有使用的对象都必须通过执行器的 `getElementInfo` 存在性和类型校验。

## 场景与参数

| 场景 | 操作 |
| --- | --- |
| 普通源参与人 `not_found` | 自动按类型兜底，不需要额外开关。 |
| 普通源身份仅缺父组织名 | 使用执行器支持的缺失证据兜底；其他字段缺失不能一概放行。 |
| 源身份 `search_failed` | 当前版本允许在白名单环境尝试有效兜底。必须区分查询失败和确实不存在；以工具诊断为准。 |
| 模板 readers/editors/allReaders/allEditors/temporaryReaders/temporaryEditors 无法匹配 | 对已有相应类型配置的任务主动加 `--allow-template-authorization-fallback`，不重复询问。仍由工具拒绝歧义和不合法身份。 |
| DSL 已有直接目标人员 fdId，精确读取结果 `not_found` | 已配置人员兜底时加 `--allow-missing-direct-person-fallback`。 |
| DSL 已有直接目标岗位 fdId，精确读取结果 `not_found` | 已配置岗位兜底时加 `--allow-missing-direct-post-fallback`。 |
| 未带类型的旧直接 fdId | 仅在源证据确证为人员且该 ID 对应唯一直接身份时，使用 `--direct-person-fallback-id 原fdId`；该参数不是兜底目标 ID。没有类型证据不猜。 |
| 条件组织名称／编号未唯一解析或查询失败 | 在允许环境内使用组织配置；这一规则不同于普通参与人歧义阻塞。 |
| DSL 已审查确认的 `configured_person_fallback` | 保留原有审查与源公式证据，由执行器落实人员配置；不为任意失败公式新造这种决定。 |

仅给 env 配置 fdId 不会自动打开模版权限和直接目标的开关；Agent 要在首次执行前读可信 DSL 并主动选参数。用户已禁用某类兜底时不带该开关。当前全局模版权限开关不是按集合或 ID 的细粒度授权：若用户只允许部分权限对象而全局开关会超范围，不使用全局开关。

## 目标环境

本 skill 对应版本允许的完整 origin：

```text
https://p-sit.onewo.com
http://mkpaaspoc.shanghai-electric.com
http://oa-dev.shanghai-electric.com:8088
http://oadev.shanghai-electric.com
http://oaqas.shanghai-electric.com
https://oaqas.shanghai-electric.com
```

默认 HTTPS 端口 `443` 等价；其他端口、相似域名、子域名不自动获准。技能文件不会升级引擎：旧发布包可能缺 HTTPS 条目，出现拒绝时保留 `releaseId` 和诊断，安排工具更新，不降级 HTTP、不重写白名单。

以下情况不能用临时参与人兜底：目标分类 fdId 缺失、可信校验失败、普通参与人匹配歧义、直接目标读取异常或类型不符、兜底对象不存在/验证失败、未配置角色线。只报告无法自行解决的具体项，不把其他已可处理的项一起退回用户。

## 失败后先检查副作用

不能只凭“失败”“未完成”或 Agent 自己的文字判断没写入。检查实际 JSON、退出码、意图文件和关联批次；当前单项报告包含 `remoteWriteAttempted`、`writeOutcomeUnknown`、创建/更新 ID 及阶段记录。

| 证据 | 处理 |
| --- | --- |
| 完整失败报告明确 `remoteWriteAttempted: false`、`writeOutcomeUnknown: false`，没有创建/更新 ID，阶段及关联历史也证明未写入 | 修正已有授权内的缺失参数（例如漏带兜底开关）后可继续。保留旧报告，记录新尝试原因和新意图/报告路径，不要求再次授权。无实际修正不重复跑。 |
| `remoteWriteAttempted: true`，已有目标，即使后续报错 | 保留目标和回执；不重复新建。调查或进入另行授权的既有修复路径。 |
| `writeOutcomeUnknown: true`、超时/断线/进程中断、意图存在而报告缺失或字段不足 | 停止重放。只读核查，不换目录、用户 home、迁移键或模板名绕过。 |
| `readback_failed` | 保存已创建模板和完整回读证据；普通迁移任务不自动执行锁定草稿修复或回调补写。 |
| `transfer_record_failed` | 保留模板及记录 ID，禁止重新迁移和重新发送回调。 |

同一任务各次尝试和证据都保留；新路径只是保存证据，不能让曾经未知的写入变成“新任务”。检查不到证据不是没有副作用。

阻塞只汇报一次：源流程、失败阶段/诊断、写入状态、已核查事项、推荐下一步、确实缺少的参数。没有状态变化时不继续刷“等你确认”。
