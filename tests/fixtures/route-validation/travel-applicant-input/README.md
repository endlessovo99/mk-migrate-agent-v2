# Travel advance visible companion

Form-only source4 `16ca78f62405f766539c7264074b881d`, template IDs replaced.
申请人1 is a required 150px xtext .name input beside a zero-width department
selector, despite its disabled/stale title binding. Actual JSP proves independent
visible input rendering beside 申请部门. Preserve input and required state; do not
interpret a disabled title binding as a hidden input. Fake persistence tests only.
