# Source-bound dynamic link button

`native-dynamic-link-button` is an opt-in migration policy for a source-proven, URL-only onLoad anchor. It replaces the generated `xform-hyperlinks` control with a non-stored native button. The ordinary mapping remains unchanged without the policy. The policy is currently scoped to `https://oaqas.shanghai-electric.com`; the normal new-`MK_TEST_` draft, category, credential, confirmation, readback and transfer-record gates remain in force.

The rule requires one matching source script and String field, an unconditional rendered anchor and matching runtime script, a closed source row with matching physical designer/runtime grid, stable source globals, the exact source script hash, and target runtime releases and asset hashes. Unsupported or ambiguous source shapes stop rather than silently losing behavior. The generated button retains the source row/column, captures the source field value at load for that form instance, hides when that value is empty, and uses the source anchor's default or explicit target. It passes nonempty address text to `window.open` without protocol filtering, trimming or adding query parameters. Browser and platform navigation behavior still applies.

The old source reads the first matching DOM input; the target reads the current native model value. The source evidence may not prove those values equivalent. The operator must explicitly choose `sourceReadPolicy: "native-current-value"`, retain the caller's approval in the policy authorization evidence, and retain the emitted `migration.dynamic_link.current_value_unproven` warning when the source binding is unproven. Relative addresses resolve against the target page, whose base can differ from the old page; `migration.dynamic_link.resolution_context_unproven` records that limitation. The export cannot prove the embedding legacy shell's default base or target.

An existing batch item's `migrationPolicies` uses the normal version-1 envelope described in [controlled REST selectors](controlled-rest-selectors.md). Its decision must contain exactly:

```json
{
  "kind": "native-dynamic-link-button",
  "sourceRef": "<exact source script reference>",
  "sourceJavascriptSha256": "sha256:<source script SHA-256>",
  "actionId": "<exact original onLoad action ID>",
  "fieldId": "<generated link field ID>",
  "sourceUrlFieldId": "<source URL field ID>",
  "sourceReadPolicy": "native-current-value"
}
```

Build the envelope's `sourceDraftSha256` using `migrationPolicySourceDigest` on the freshly cleaned source draft. The script reference, IDs and script hash must come from that same draft and its independently generated DSL draft. The envelope must bind the exact QAS root origin, target category and user-authorization evidence. A changed source, unsupported anchor, changed runtime bundle or mismatched policy blocks execution.

The policy creates new drafts only. It does not authorize publication, existing-template repair, replay of an uncertain write, business-instance submission or approval. Designer preview skips global onLoad; a preview-only check cannot establish the automatic runtime lifecycle. The QAS investigation for this rule published one separately authorized synthetic template and exercised its official configuration in an isolated native view-mode harness with synthetic in-memory data; this is not acceptance of the original business flow or a real mobile device.
