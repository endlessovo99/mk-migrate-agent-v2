# IT procurement address display companion

Minimal department row extracted from source4 form 16701bda9a11a905b4417f7406384735. The 使用部门 text field
fd_use_dept.name shares an active caption with a zero-width 使用部门选择 selector.
No script refers to the name field. A native address control can represent this
pair without an additional text column. Independently named inputs, defaults,
readonly inputs and referenced name fields must not be folded. Fake persistence only.
