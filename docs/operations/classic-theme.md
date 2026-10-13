# 迁移后的统一主题

正常新建草稿迁移固定使用经典主题：桌面端 `classic`，移动端 `classic`。无需更改 XML、DSL 或环境变量；`dry-run` 的保存和回读步骤会列出两端主题。

主题在原有 `kmReviewTemplate/update` 请求内写入
`mechanisms.sys-xform.fdConfig → viewModel[].fdConfig` 的 `theme` 和 `controlStyle`。
控件样式按当前表单的主表字段、明细表名称及明细列引用生成，不使用抓包示例中的字段 ID。
原有布局、字段、权限、事件脚本和流程定义保持不变，说明文字的来源颜色、加粗和纵向布局优先保留。

保存后回读必须保留两端主题及投影样式，执行报告的 `readback.theme.status` 才会为 `verified`。
主题丢失或变回默认主题会返回 `readback_failed`，保留已经创建的草稿，不发送迁移记录回调，不自动重试。
此前报告声明过主题要求时，记录补记也会检查该要求；受限草稿修复不允许顺带修复主题，主题不满足要求时停止。
历史报告没有主题要求时沿用原有恢复规则。已发布表单修复和指定既有模板的执行不新增主题写入。

桌面配置来自用户提供的主题保存请求。用户确认移动端同样使用 `classic` 并免于再次抓包，移动端据同一主题结构设置选择器、保留纵向布局，并使用经典主题的通用文字样式。
本地测试证明请求生成、回读约束与失败处理；没有在真实 NewOA 上保存或验证移动端页面效果。

对应实现：`src/executor/template-theme.js`；配置：`catalogs/mk-classic-theme.v1.json`；
路由用例：`tests/route-validation/template-theme.test.js`。
