# Expense header versus footer regression

Form-only root evidence from source4 `16cfa01c2b238241f6da8df46bd9cbb2`,
with template IDs replaced and history/workflow omitted. The labor-cost detail
contains header 内容及科目变化 and footer 合计 at the same source column.
Its unbound select retains a stale caption ID and internal metadata label
人工成本相关内容及科目编号. Footer text must not make the true header ambiguous.
Default tests use fake persistence only and preserve options/calculations.
