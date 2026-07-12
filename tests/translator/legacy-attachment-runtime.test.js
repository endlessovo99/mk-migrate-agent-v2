import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftMkScriptsFromSourceScripts } from "../../src/translator/sysform-jsp-scripts.js";

describe("legacy attachment runtime scripts", () => {
  it("omits the WebUploader CSS and refresh patch when the form has an MK attachment field", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source(`(function() {
        var style = document.createElement('style');
        style.innerHTML = '.swfuploadbutton { overflow: hidden !important; position: relative !important; }' +
          'div[id^="rt_rt_"] { width: 100% !important; }' +
          'div[id^="attachmentObject_"][style*="display: none"] { pointer-events: none !important; }';
        document.getElementsByTagName('head')[0].appendChild(style);
        window.onload = function() {
          setTimeout(function() {
            for (var key in window) {
              if (key.indexOf('attachmentObject_') === 0 && window[key] && window[key].uploader) window[key].uploader.refresh();
            }
          }, 1000);
        };
      })();`)]
    }, { form: attachmentForm() });

    assert.deepEqual(scripts.actions[0], {
      id: "attachment-runtime.script.1.event.1",
      name: "onLoad",
      event: "onLoad",
      scope: "global",
      function: "",
      sourceRefs: ["source.form.jsp.attachment-runtime.script.1"],
      translationStatus: "omitted",
      coverage: { status: "covered", nativeRules: [], residuals: [] },
      functionMappings: [{
        source: "legacy WebUploader CSS/refresh patch",
        target: "xform-attach native rendering",
        basis: "legacy-runtime-noop",
        reviewRequired: false
      }],
      unmappedFunctions: ["document.createElement"]
    });
  });

  it("keeps an attachment runtime script with business field mutation reviewable", () => {
    const scripts = draftMkScriptsFromSourceScripts({
      source: "sysform-jsp",
      sources: [source("var style = document.createElement('style'); .swfuploadbutton; div[id^=\"rt_rt_\"]; attachmentObject_; window.onload = function() { window.uploader.refresh() }; GetXFormFieldById('fd_subject')[0].value = 'x';")]
    }, { form: attachmentForm() });

    assert.equal(scripts.actions[0].translationStatus, "needs_review");
  });
});

function source(javascript) {
  return {
    id: "attachment-runtime.script.1",
    sourceRef: "source.form.jsp.attachment-runtime.script.1",
    javascript,
    functionAudit: { matched: [], violations: [{ name: "document.createElement" }] }
  };
}

function attachmentForm() {
  return {
    fields: [{ id: "fd_attachment", title: "附件", type: "attachment", componentId: "xform-attach", props: {} }]
  };
}
