# Leader leave form layout regression

Form-only root designer/display/metadata evidence from source4
`16a8bd7781ed64ffed973314ec2a5721`; identifiers replaced and workflow/history omitted.
Preserves independent captions, visible person/department name inputs, address
selectors, and begin/separator/end dates in a single source cell.

The screenshot of `MK_TEST_电气数科领导干部请假申请_20260905123046`
shows duplicate control titles and stacked controls. The native row contract is
documented in the adjacent business-card-layout fixture. Date controls use the
same native field wrapper hiddenLabel contract already persisted by the writer.
Tests use fake clients only.
