# Source Format

The real v2 source format is not locked yet.

For repo bootstrapping, `tests/fixtures/new-source.sample.json` provides a small placeholder source shape:

```json
{
  "templateName": "MK_TEST_V2_SAMPLE",
  "categoryPath": "测试/公共流程",
  "fields": [
    { "id": "fd_subject", "title": "主题", "type": "text", "required": true }
  ]
}
```

Replace this with the real latest source file as soon as one sample is available. Do not add legacy source compatibility while doing that replacement.
