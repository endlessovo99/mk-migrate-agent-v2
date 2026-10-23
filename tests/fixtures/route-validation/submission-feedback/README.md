# Submission feedback route

Minimal source-backed reproduction of the October 23 feedback: a row contains a
display-only heading and a required detail column, and a synchronous submit guard
alerts before returning false. The actual source helper follows the same hidden
state plus row-visibility pattern as the reported forms.

The tests execute the projected action with captured native attribute and message
APIs. They check both selected/unselected states and desktop/mobile notification
contracts, without publishing or submitting a real document.

The source `alert` whitelist warning remains visible; its deterministic mapped
action executes through the existing warning-only review route.
