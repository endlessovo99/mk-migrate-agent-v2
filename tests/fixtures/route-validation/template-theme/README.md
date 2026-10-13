# Classic theme contract

The desktop theme and desktop control-style values come from the user's sanitized
2026-10-10 `kmReviewTemplate/update` request. No request tokens, people, template
identities, or sample field identities are retained.

The sample mobile theme was `default`. The user explicitly chose `classic` on
mobile as well and waived a further capture. The mobile projection uses the same
theme-selection structure, retains the evidenced vertical mobile layout and form
title, and shares the classic label/value typography. This is an implementation
contract, not evidence of mobile rendering on the live deployment.

Tests exercise the XML-to-DSL-to-new-draft path with fake clients, including loss
of either theme or its styles and preservation of business configuration. Theme
loss prevents the transfer-record callback. Existing-template repair paths must
not write theme changes.
