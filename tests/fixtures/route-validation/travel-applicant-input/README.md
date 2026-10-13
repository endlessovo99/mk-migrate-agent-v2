# Travel advance applicant name companion

Form-only source4 `16ca78f62405f766539c7264074b881d`, template IDs replaced.
The legacy 申请人1 field is a required 150px xtext .name input paired with
申请人2, a zero-width department selector, under the same source caption.

Confirmed MK rule: fold this display/selector pair into the native address
control, retaining the source display width and transferring required validation.
Do not recreate a separate .name column. Referenced name fields retain their
semantics until their consumers can be translated. Fake persistence tests only.
