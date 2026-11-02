import { nativeOtherChoiceBindings } from "./native-other-checkbox.js";
import { NATIVE_OTHER_DISPLAY_CAPABILITY as capability } from "./native-other-display-capability.js";

/** Correct the verified native widget's underscore truncation without writing form data. */
export function withNativeOtherDisplayRuntime(scripts = {}, form = {}, mainTableName) {
  const bindings = nativeOtherChoiceBindings(form);
  if (!bindings.length) return scripts;
  if (typeof mainTableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(mainTableName) ||
      bindings.some(binding => !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(binding.choiceId))) {
    const error = new Error("Native Other display requires qualified field identities.");
    error.code = "projection.native_other_display.invalid_identity";
    throw error;
  }
  const specs = bindings.map(binding => {
    const options = form.fields.find(field => field.id === binding.choiceId).props.options;
    return { ref: `${mainTableName}.${binding.choiceId}`, kind: binding.componentId === "xform-radio" ? "radio" : "checkbox",
      options: options.filter(option => option.type !== "other").map(option => option.value),
      labels: options.filter(option => option.type !== "other").map(option => option.label),
      otherRequired: options.find(option => option.type === "other")?.isRequired === true };
  });
  const urls = Object.fromEntries(Object.entries(capability.releases).map(([id, hash]) => {
    const path = id.slice("@elem/".length);
    return [id, `${capability.origin}/web/sys/artifact/elements/${path}/index.js?${hash}`];
  }));
  const action = { id: "mk-native-other-display-v1", name: "onLoadNativeOtherDisplay", event: "onLoad", scope: "global", translationStatus: "mapped",
    function: `function onLoadNativeOtherDisplay(context) {
  if (typeof MKXFORM === "undefined" || !MKXFORM || typeof MKXFORM.beforeSubmit !== "function")
    throw new Error("Native Other display requires the verified submit API.");
  var form = MKXFORM.$$FORM && MKXFORM.$$FORM.current, container = MKXFORM.MKXFORM_DATA_CONTAINER,
    previous = container && container.__mkNativeOtherDisplayV1;
  if (previous && previous.form === form) return;
  var gate = { ready: false, check: null };
  MKXFORM.beforeSubmit(function() { return gate.ready && typeof gate.check === "function" && gate.check(); },
    "其他选项内容为空、超长或尚未同步，请检查并重新输入后重试。");
  if (!container || !form || typeof MKXFORM.getValue !== "function" || typeof MKXFORM.getFieldAttr !== "function" ||
      typeof MKXFORM.setValue !== "function" || typeof MKXFORM.onChange !== "function" ||
      typeof document === "undefined" || !document || !document.body || typeof MutationObserver !== "function" ||
      typeof setTimeout !== "function") return;
  if (previous) { if (previous.observer) previous.observer.disconnect(); document.removeEventListener("input", previous.input, true);
    document.removeEventListener("focusout", previous.blur, true); document.removeEventListener("compositionstart", previous.compositionStart, true);
    document.removeEventListener("compositionend", previous.compositionEnd, true); document.removeEventListener("beforeinput", previous.beforeInput, true);
    document.removeEventListener("focusin", previous.focus, true); document.removeEventListener("change", previous.change, true);
    document.removeEventListener("click", previous.click, true); document.removeEventListener("keydown", previous.keydown, true);
    document.removeEventListener("keyup", previous.keyup, true); document.removeEventListener("pointerdown", previous.pointerdown, true);
    document.removeEventListener("pointerup", previous.pointerup, true); }
  var specs = ${JSON.stringify(specs)}, urls = ${JSON.stringify(urls)}, origin = ${JSON.stringify(capability.origin)}, pending = {}, composing = {}, pendingChoice = {}, choiceBefore = {}, settled = {};
  function current() { return MKXFORM && MKXFORM.$$FORM && MKXFORM.$$FORM.current === form; }
  function nativeText(value) { return value.split("_")[0].replace(/(^\\s*)|(\\s*$)/g, ""); }
  function available(url) { return typeof location !== "undefined" && location.origin === origin &&
    Array.prototype.some.call(document.scripts || [], function(script) { return script.src === url; }); }
  function text(value, spec) {
    if (value === undefined || value === null || value === "") return { status: "none", parts: [] };
    var parts;
    if (Array.isArray(value)) parts = value;
    else if (typeof value === "string") {
      if (spec.kind === "radio") parts = [value];
      else { parts = value.split(","); var index = parts.findIndex(function(item) { return item.indexOf("other_") === 0; });
        if (index >= 0) parts = parts.slice(0, index).concat([parts.slice(index).join(",")]); }
    } else return { status: "invalid" };
    if (spec.kind === "radio" && parts.length > 1 || parts.some(function(item) { return typeof item !== "string" ||
        (spec.options.indexOf(item) < 0 && item.indexOf("other_") !== 0); })) return { status: "invalid" };
    var found = parts.filter(function(item) { return item.indexOf("other_") === 0; });
    if (found.length > 1 || new Set(parts).size !== parts.length) return { status: "invalid" };
    return found.length ? { status: "other", value: found[0].slice(6), parts: parts } : { status: "none", parts: parts };
  }
  function roots(spec) { return Array.prototype.filter.call(document.querySelectorAll('[data-id="' + spec.ref + '"]'),
    function(node) { return node.getClientRects().length > 0; }); }
  function restore(spec, selection) {
    if (!current()) return true;
    var found = roots(spec), parsed = text(MKXFORM.getValue(spec.ref), spec);
    if (parsed.status === "invalid") return false;
    if (found.length > 1) return false;
    var edit = pending[spec.ref];
    if (edit && (edit.conflict || edit.composing || edit.navigationPending)) return false;
    if (found.length === 1 && (edit || parsed.status === "other")) {
      var root = found[0], mobile = Boolean(root.querySelector(".ele-xform-m-" + spec.kind)),
        moduleId = mobile ? "@elem/xform-m-" + spec.kind : "@elem/xform-" + spec.kind;
      if (!available(urls[moduleId]) && (mobile || !available(urls["@elem/xform-bundle-desktop"]))) return false;
    }
    if (edit && (!edit.target.isConnected || found.length === 0 || !found[0].contains(edit.target))) {
      if (parsed.status === "none" && pendingChoice[spec.ref] && pendingChoice[spec.ref].checked &&
          pendingChoice[spec.ref].checked[spec.options.length] === false) { delete pending[spec.ref]; delete settled[spec.ref]; edit = null; }
      else if (parsed.status === "other" && parsed.value === edit.value) {
        settled[spec.ref] = { value: edit.value, previous: edit.previous, history: edit.history || [], target: edit.target };
        delete pending[spec.ref]; edit = null;
      }
      else if (found.length === 1) {
        var replacement = found[0].querySelector(".ele-" + spec.kind + "-other input[type=text]");
        if (replacement) edit.target = replacement; else return false;
      } else return false;
    }
    if (edit) {
      if (edit.target.value !== edit.value) edit.target.value = edit.value;
      if (selection && selection.target === edit.target && document.activeElement === edit.target && selection.start !== null && selection.end !== null)
        edit.target.setSelectionRange(Math.min(selection.start, edit.value.length), Math.min(selection.end, edit.value.length));
      if (parsed.status !== "other") return false;
      if (parsed.value !== edit.value) {
        var currentAttr = MKXFORM.getFieldAttr(spec.ref);
        if ((currentAttr !== 2 && currentAttr !== 3) || edit.target.disabled || edit.target.readOnly) return false;
        var next = spec.kind === "radio" ? "other_" + edit.value :
          parsed.parts.filter(function(value) { return value.indexOf("other_") !== 0; }).concat(["other_" + edit.value]);
        MKXFORM.setValue(spec.ref, next);
        parsed = text(MKXFORM.getValue(spec.ref), spec);
      }
      if (parsed.status !== "other" || parsed.value !== edit.value) return false;
      if (edit.awaitingFinal) return false;
      if (!edit.cleanupScheduled) {
        edit.cleanupScheduled = true;
        setTimeout(function() {
          if (!current() || pending[spec.ref] !== edit) return;
          if (edit.conflict || edit.composing || edit.navigationPending || edit.awaitingFinal ||
              !edit.target.isConnected || edit.target.value !== edit.value) { edit.cleanupScheduled = false; return; }
          try {
            var latest = text(MKXFORM.getValue(spec.ref), spec);
            if (latest.status === "other" && latest.value === edit.value) {
              settled[spec.ref] = { value: edit.value, previous: edit.previous, history: edit.history || [], target: edit.target };
              delete pending[spec.ref];
            }
            else { edit.cleanupScheduled = false; schedule(); }
          } catch (_) { /* Leave the edit pending so submission fails closed. */ }
        }, 0);
      }
      return true;
    }
    if (found.length === 0 || parsed.status === "none") return true;
    var expected = parsed.value;
    if (found.length !== 1) return false;
    var selector = ".ele-" + spec.kind + "-other input[type=text], .ele-xform-" + spec.kind + "-fake-input, .ele-xform-m-" + spec.kind + "-fake-input";
    var matches = root.querySelectorAll(selector);
    if (matches.length === 0) {
      var view = root.querySelector(".ele-xform-view, .ele-xform-m-view");
      return Boolean(view && view.textContent.indexOf(expected) >= 0);
    }
    if (matches.length !== 1) return false;
    var node = matches[0];
    if (node.tagName === "INPUT") {
      if (node.value !== expected) {
        node.value = expected;
        if (selection && selection.target === node && document.activeElement === node && selection.start !== null && selection.end !== null)
          node.setSelectionRange(Math.min(selection.start, expected.length), Math.min(selection.end, expected.length));
      }
      return node.value === expected;
    }
    if (node.textContent !== expected) node.textContent = expected;
    return node.textContent === expected;
  }
  function refresh(selection) {
    if (!current()) return false;
    var ok = true; specs.forEach(function(spec) { try { if (!restore(spec, selection)) ok = false; } catch (_) { ok = false; } }); return ok;
  }
  function selectionSnapshot(spec, root) {
    var mobile = Boolean(root.querySelector(".ele-xform-m-" + spec.kind)),
      moduleId = mobile ? "@elem/xform-m-" + spec.kind : "@elem/xform-" + spec.kind;
    if (!available(urls[moduleId]) && (mobile || !available(urls["@elem/xform-bundle-desktop"]))) return null;
    var selector = ".ele-xform-" + spec.kind + " input[type=" + spec.kind + "], .ele-xform-m-" + spec.kind + " input[type=" + spec.kind + "]";
    var inputs = Array.prototype.slice.call(root.querySelectorAll(selector));
    if (inputs.length !== spec.options.length + 1 || mobile && spec.kind === "checkbox" &&
        (spec.labels.some(function(label) { return typeof label !== "string" || !label; }) || new Set(spec.labels).size !== spec.labels.length)) return null;
    var valid = inputs.every(function(node, index) {
      if (!node || typeof node.checked !== "boolean" || typeof node.closest !== "function") return false;
      var isOther = Boolean(node.closest(".ele-" + spec.kind + "-other"));
      if (isOther !== (index === spec.options.length)) return false;
      if (!isOther && mobile && spec.kind === "checkbox") {
        var wrapper = node.closest("label"), title = wrapper && wrapper.querySelector(".ele-item-text[title]");
        if (!title || title.getAttribute("title") !== spec.labels[index]) return false;
      } else if (!isOther && node.value !== spec.options[index]) return false;
      return true;
    });
    return valid ? inputs.map(function(node) { return node.checked; }) : null;
  }
  function selectionSynchronized(spec, value) {
    var attr = MKXFORM.getFieldAttr(spec.ref), found = roots(spec), all = document.querySelectorAll('[data-id="' + spec.ref + '"]'),
      pendingSelection = pendingChoice[spec.ref];
    if ([1, 2, 3, 4].indexOf(attr) < 0 || all.length > 1) return false;
    if (all.length === 0) return (attr === 1 || attr === 4) && !pendingSelection;
    if ((found.length === 0 || attr === 1 || attr === 4) && !pendingSelection) {
      var enabled = all[0].querySelectorAll("input[type=checkbox]:not(:disabled), input[type=radio]:not(:disabled)");
      if (found.length === 0 || enabled.length === 0) return true;
      if (attr === 1 || attr === 4) return false;
    }
    if ((attr === 1 || attr === 4) && pendingSelection) return false;
    var checked = selectionSnapshot(spec, all[0]);
    if (!checked || pendingSelection && (!pendingSelection.checked ||
        checked.some(function(item, index) { return item !== pendingSelection.checked[index]; }))) return false;
    var matches = checked.every(function(item, index) {
      return item === (index === spec.options.length ? value.status === "other" : value.parts.indexOf(spec.options[index]) >= 0);
    });
    if (matches) delete pendingChoice[spec.ref];
    return matches;
  }
  var timer = null, pendingSelection = null;
  function schedule(selection) {
    if (selection) pendingSelection = selection;
    if (timer !== null) return;
    timer = setTimeout(function() { timer = null; var saved = pendingSelection; pendingSelection = null;
      if (current()) {
        refresh(saved);
        specs.forEach(function(spec) {
          if (!pendingChoice[spec.ref]) return;
          try { selectionSynchronized(spec, text(MKXFORM.getValue(spec.ref), spec)); } catch (_) { /* Keep selection pending. */ }
        });
      } }, 0);
  }
  function input(event) {
    var target = event.target;
    if (!target || target.tagName !== "INPUT" || target.type !== "text" || !target.closest) return;
    var root = target.closest("[data-id]"), ref = root && root.getAttribute("data-id");
    if (!specs.some(function(spec) { return spec.ref === ref; }) || !target.closest(".ele-checkbox-other, .ele-radio-other")) return;
    if (event.isComposing && !composing[ref]) composing[ref] = { unproven: true };
    var spec = specs.find(function(item) { return item.ref === ref; }), prior = pending[ref], value = target.value;
    if (prior && prior.conflict && !prior.explicitReplace) { prior.inputEvent = event; schedule(); return; }
    if (prior && prior.awaitingFinal && !event.isComposing && prior.beforeInputValue !== prior.value && !prior.explicitReplace) {
      var truncated = nativeText(prior.value);
      if (value === prior.value) { /* Complete final value, no reconstruction needed. */ }
      else if (value === truncated && typeof event.data === "string" && event.data === prior.compositionData) value = prior.value;
      else { prior.conflict = true; prior.inputEvent = event; schedule(); return; }
    }
    var last = settled[ref], history = prior && Array.isArray(prior.history) ? prior.history.slice() :
      last && Array.isArray(last.history) ? last.history.slice() : [];
    if (!prior && last && typeof last.value === "string" && history.indexOf(last.value) < 0) history.push(last.value);
    if (!prior && last && typeof last.previous === "string" && history.indexOf(last.previous) < 0) history.push(last.previous);
    if (prior && typeof prior.value === "string" && history.indexOf(prior.value) < 0) history.push(prior.value);
    if (history.length > 512) { pending[ref] = { target: target, value: value, conflict: true }; schedule(); return; }
    var previous;
    try { previous = text(MKXFORM.getValue(ref), spec); }
    catch (_) { pending[ref] = { target: target, value: value, conflict: true }; schedule(); return; }
    pending[ref] = { target: target, value: value, previous: previous.status === "other" ? previous.value : null, history: history,
      start: target.selectionStart, end: target.selectionEnd,
      inputEvent: event, composing: Boolean(composing[ref] || event.isComposing) };
    delete settled[ref];
    schedule({ target: target, start: target.selectionStart, end: target.selectionEnd });
  }
  function change(event) {
    var target = event.target;
    if (!target || target.tagName !== "INPUT" || (target.type !== "checkbox" && target.type !== "radio") || !target.closest) return;
    var root = target.closest("[data-id]"), ref = root && root.getAttribute("data-id");
    var spec = specs.find(function(item) { return item.ref === ref && item.kind === target.type; });
    if (spec) {
      if (!(pendingChoice[ref] && pendingChoice[ref].radioReselect)) {
        try { pendingChoice[ref] = { checked: selectionSnapshot(spec, root) }; }
        catch (_) { pendingChoice[ref] = { checked: null }; }
      }
      schedule();
    }
  }
  function click(event) {
    var target = event.target;
    if (!target || target.tagName !== "INPUT" || !target.closest) return;
    if (target.type === "text") { finishNavigation(target); return; }
    if (target.type === "checkbox") {
      var checkboxRoot = target.closest("[data-id]"), checkboxRef = checkboxRoot && checkboxRoot.getAttribute("data-id"),
        checkboxSpec = specs.find(function(item) { return item.ref === checkboxRef && item.kind === "checkbox"; });
      if (checkboxSpec) {
        try { pendingChoice[checkboxRef] = { checked: selectionSnapshot(checkboxSpec, checkboxRoot) }; }
        catch (_) { pendingChoice[checkboxRef] = { checked: null }; }
        schedule();
      }
      return;
    }
    if (target.type !== "radio") return;
    var root = target.closest("[data-id]"), ref = root && root.getAttribute("data-id"),
      spec = specs.find(function(item) { return item.ref === ref && item.kind === "radio"; });
    if (!spec) return;
    try {
      var checked = selectionSnapshot(spec, root), before = choiceBefore[ref],
        inputs = Array.prototype.slice.call(root.querySelectorAll(".ele-xform-radio input[type=radio], .ele-xform-m-radio input[type=radio]")),
        index = inputs.indexOf(target), reselect = Boolean(before && before.target === target && before.checked && before.checked[index]);
      if (!before || before.target !== target || index < 0) checked = null;
      delete choiceBefore[ref];
      pendingChoice[ref] = { checked: checked && (reselect ? checked.map(function() { return false; }) : checked), radioReselect: reselect };
    } catch (_) { pendingChoice[ref] = { checked: null }; }
    schedule();
  }
  function beforeInput(event) {
    var target = event.target, root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id"), edit = ref && pending[ref];
    if (!edit || event.isComposing) return;
    if (edit.target !== target) { edit.conflict = true; return; }
    if (edit.conflict) {
      edit.explicitReplace = (edit.recoveryFocused || edit.conflictReason === "navigation") && event.isTrusted === true &&
        event.inputType !== "insertFromComposition" && event.inputType !== "insertCompositionText" &&
        target.selectionStart === 0 && target.selectionEnd === target.value.length;
      return;
    }
    if (!edit.awaitingFinal && !edit.composing && target.value !== edit.value) {
      restoreBeforeNavigation(target, edit);
      return;
    }
    if (!edit.awaitingFinal) return;
    edit.beforeInputValue = target.value;
    edit.explicitReplace = edit.conflict && edit.recoveryFocused && event.isTrusted === true &&
      target.selectionStart === 0 && target.selectionEnd === target.value.length;
  }
  function restoreBeforeNavigation(target, edit) {
    if (target.value === edit.value) return true;
    var truncated = nativeText(edit.value), start = edit.start, end = edit.end;
    if (target.value !== truncated || !Number.isInteger(start) || !Number.isInteger(end) ||
        !edit.controlledSelection && (target.selectionStart !== Math.min(start, target.value.length) || target.selectionEnd !== Math.min(end, target.value.length))) {
      edit.conflict = true; edit.conflictReason = "navigation"; return false;
    }
    target.value = edit.value;
    try { target.setSelectionRange(start, end); return true; }
    catch (_) { edit.conflict = true; edit.conflictReason = "navigation"; return false; }
  }
  function finishNavigation(target) {
    var root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id"), edit = ref && pending[ref];
    if (!edit || !edit.navigationPending || edit.target !== target) return;
    edit.navigationPending = false;
    if (target.value !== edit.value || !Number.isInteger(target.selectionStart) || !Number.isInteger(target.selectionEnd)) {
      edit.conflict = true; edit.conflictReason = "navigation"; return;
    }
    edit.start = target.selectionStart; edit.end = target.selectionEnd;
    edit.controlledSelection = true;
    schedule({ target: target, start: edit.start, end: edit.end });
  }
  function beginNavigation(target) {
    var root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id"), edit = ref && pending[ref];
    if (!edit || edit.target !== target || edit.conflict || edit.composing || edit.awaitingFinal) return null;
    if (restoreBeforeNavigation(target, edit)) { edit.navigationPending = true; return edit; }
    return null;
  }
  function moveCaret(event, target) {
    var edit = beginNavigation(target);
    if (!edit) return;
    var all = (event.ctrlKey || event.metaKey) && /^(?:a|A)$/.test(event.key),
      direction = target.selectionDirection || "none", start = target.selectionStart, end = target.selectionEnd,
      anchor = direction === "backward" ? end : start, focus = direction === "backward" ? start : end, next,
      mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || ""),
      word = mac && event.altKey && !event.ctrlKey && !event.metaKey && /^(?:ArrowLeft|ArrowRight)$/.test(event.key) &&
        /^[A-Za-z0-9_\\s]*$/.test(edit.value);
    if (typeof event.preventDefault !== "function") {
      edit.navigationPending = false; edit.conflict = true; edit.conflictReason = "navigation"; return;
    }
    if (!all && !word && ((event.ctrlKey || event.metaKey || event.altKey) ||
        /^(?:ArrowUp|ArrowDown)$/.test(event.key) && !mac)) {
      event.preventDefault(); edit.navigationPending = false;
      schedule({ target: target, start: start, end: end }); return;
    }
    if (all) { start = 0; end = edit.value.length; direction = "forward"; }
    else {
      if (event.key === "Home" || event.key === "ArrowUp") next = 0;
      else if (event.key === "End" || event.key === "ArrowDown") next = edit.value.length;
      else {
        var boundaries = [0];
        if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
          edit.navigationPending = false; edit.conflict = true; edit.conflictReason = "navigation"; return;
        }
        var segments = Array.from(new Intl.Segmenter(undefined, { granularity: word ? "word" : "grapheme" }).segment(edit.value));
        if (word) {
          var words = segments.filter(function(part) { return part.isWordLike; });
          if (event.key === "ArrowLeft") next = (words.filter(function(part) { return part.index < focus; }).pop() || { index: 0 }).index;
          else { var foundWord = words.find(function(part) { return part.index + part.segment.length > focus; });
            next = foundWord ? foundWord.index + foundWord.segment.length : edit.value.length; }
        } else segments.forEach(function(part) {
          var boundary = part.index + part.segment.length; if (boundaries.indexOf(boundary) < 0) boundaries.push(boundary);
        });
        if (!event.shiftKey && start !== end) next = event.key === "ArrowLeft" ? start : end;
        else if (!word && event.key === "ArrowLeft") next = boundaries.filter(function(point) { return point < focus; }).pop() || 0;
        else if (!word) next = boundaries.find(function(point) { return point > focus; });
        if (next === undefined) next = edit.value.length;
      }
      if (event.shiftKey) { start = Math.min(anchor, next); end = Math.max(anchor, next); direction = next < anchor ? "backward" : "forward"; }
      else { start = next; end = next; direction = "none"; }
    }
    event.preventDefault();
    try { target.setSelectionRange(start, end, direction); }
    catch (_) { edit.navigationPending = false; edit.conflict = true; edit.conflictReason = "navigation"; return; }
    edit.navigationPending = false; edit.start = start; edit.end = end; edit.controlledSelection = true;
    schedule({ target: target, start: start, end: end });
  }
  function rememberRadio(target) {
    var label = target && target.closest && target.closest("label"), input = target && target.type === "radio" ? target : label && label.querySelector("input[type=radio]"),
      root = input && input.closest("[data-id]"), ref = root && root.getAttribute("data-id"),
      spec = specs.find(function(item) { return item.ref === ref && item.kind === "radio"; });
    if (!spec) return;
    try { choiceBefore[ref] = { target: input, checked: selectionSnapshot(spec, root) }; }
    catch (_) { choiceBefore[ref] = { target: input, checked: null }; }
  }
  function keydown(event) {
    var target = event.target;
    if (!target || target.tagName !== "INPUT") return;
    if (target.type === "text" && (/^(?:ArrowLeft|ArrowRight|Home|End|ArrowUp|ArrowDown)$/.test(event.key) ||
        (event.ctrlKey || event.metaKey) && /^(?:a|A)$/.test(event.key))) moveCaret(event, target);
    if (target.type === "radio" && /^(?: |Enter|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(event.key)) rememberRadio(target);
  }
  function keyup(event) {
    if (event.target && event.target.type === "text" && (/^(?:ArrowLeft|ArrowRight|Home|End|ArrowUp|ArrowDown)$/.test(event.key) ||
        (event.ctrlKey || event.metaKey) && /^(?:a|A)$/.test(event.key))) finishNavigation(event.target);
  }
  function pointerdown(event) {
    if (event.target && event.target.type === "text") beginNavigation(event.target);
    else rememberRadio(event.target);
  }
  function pointerup(event) { if (event.target && event.target.type === "text") finishNavigation(event.target); }
  function focus(event) {
    var target = event.target, root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id"), edit = ref && pending[ref];
    if (edit && edit.conflict && edit.target === target && event.isTrusted === true) edit.recoveryFocused = true;
  }
  function compositionStart(event) {
    var target = event.target, root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id");
    if (target && target.tagName === "INPUT" && target.type === "text" && ref &&
        specs.some(function(spec) { return spec.ref === ref; }) && target.closest(".ele-checkbox-other, .ele-radio-other")) {
      var edit = pending[ref];
      var start = edit && edit.target === target ? edit.start : target.selectionStart,
        end = edit && edit.target === target ? edit.end : target.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        pending[ref] = { target: target, value: target.value, conflict: true };
        composing[ref] = { base: target.value, start: null, end: null }; return;
      }
      if (edit && edit.target === target && !edit.conflict && target.value !== edit.value) target.value = edit.value;
      else if (!edit && !refresh()) { pending[ref] = { target: target, value: target.value, conflict: true }; }
      try { target.setSelectionRange(Math.min(start, target.value.length), Math.min(end, target.value.length)); }
      catch (_) { pending[ref] = { target: target, value: target.value, conflict: true }; }
      composing[ref] = { base: target.value, start: target.selectionStart, end: target.selectionEnd };
    }
  }
  function compositionEnd(event) {
    var target = event.target, root = target && target.closest && target.closest("[data-id]"), ref = root && root.getAttribute("data-id");
    if (!ref || !composing[ref]) return;
    var composition = composing[ref];
    delete composing[ref];
    var edit = pending[ref], spec = specs.find(function(item) { return item.ref === ref; });
    if (composition.unproven) {
      if (!edit || edit.target !== target) edit = pending[ref] = { target: target, value: target.value };
      edit.composing = false; edit.awaitingFinal = true; edit.conflict = true; schedule(); return;
    }
    var currentValue;
    try { currentValue = text(MKXFORM.getValue(ref), spec); }
    catch (_) { pending[ref] = { target: target, value: target.value, conflict: true }; schedule(); return; }
    if (event.data === "" && target.value === composition.base && currentValue.status === "other" &&
        currentValue.value === composition.base && !(edit && edit.conflict)) {
      delete pending[ref]; return;
    }
    if (!edit || edit.target !== target) {
      edit = pending[ref] = { target: target, previous: currentValue.status === "other" ? currentValue.value : null };
    }
    if (typeof event.data === "string" && Number.isInteger(composition.start) && Number.isInteger(composition.end) &&
        composition.start >= 0 && composition.end >= composition.start && composition.end <= composition.base.length) {
      edit.value = composition.base.slice(0, composition.start) + event.data + composition.base.slice(composition.end);
    } else if (edit.value === undefined || target.value !== nativeText(edit.value)) edit.value = target.value;
    edit.composing = false; edit.inputEvent = event; edit.awaitingFinal = true; edit.compositionData = event.data;
    schedule({ target: target, start: target.selectionStart, end: target.selectionEnd });
  }
  function blur(event) {
    var target = event.target;
    if (!target || target.tagName !== "INPUT" || target.type !== "text" || !target.closest ||
        !target.closest(".ele-checkbox-other, .ele-radio-other")) return;
    var root = target.closest("[data-id]"), ref = root && root.getAttribute("data-id");
    if (!specs.some(function(spec) { return spec.ref === ref; })) return;
    var edit = pending[ref];
    if (edit && (edit.composing || edit.conflict || edit.navigationPending)) return;
    if (edit) edit.blurEvent = event;
    if (edit && edit.target === target && target.value !== edit.value) target.value = edit.value;
    if (!edit) {
      if (!refresh()) return;
      pending[ref] = { target: target, value: target.value, previous: target.value, blurEvent: event };
    }
    schedule();
  }
  document.addEventListener("input", input, true);
  document.addEventListener("change", change, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("keyup", keyup, true);
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("pointerup", pointerup, true);
  document.addEventListener("beforeinput", beforeInput, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("focusout", blur, true);
  document.addEventListener("compositionstart", compositionStart, true);
  document.addEventListener("compositionend", compositionEnd, true);
  var observer = new MutationObserver(function(records) {
    if (!current()) { observer.disconnect(); document.removeEventListener("input", input, true);
      document.removeEventListener("focusout", blur, true); document.removeEventListener("compositionstart", compositionStart, true);
      document.removeEventListener("compositionend", compositionEnd, true); document.removeEventListener("beforeinput", beforeInput, true);
      document.removeEventListener("focusin", focus, true); document.removeEventListener("change", change, true);
      document.removeEventListener("click", click, true); document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true); document.removeEventListener("pointerdown", pointerdown, true);
      document.removeEventListener("pointerup", pointerup, true); return; }
    var relevant = records.some(function(record) {
      var target = record.target && record.target.nodeType === 1 ? record.target : record.target && record.target.parentElement;
      var root = target && target.closest && target.closest("[data-id]");
      if (root && specs.some(function(spec) { return spec.ref === root.getAttribute("data-id"); })) return true;
      return Array.prototype.some.call(record.addedNodes || [], function(node) {
        return node.nodeType === 1 && specs.some(function(spec) {
          return node.getAttribute("data-id") === spec.ref || Boolean(node.querySelector('[data-id="' + spec.ref + '"]'));
        });
      });
    });
    if (relevant) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  container.__mkNativeOtherDisplayV1 = { form: form, observer: observer, input: input, blur: blur, compositionStart: compositionStart, compositionEnd: compositionEnd, beforeInput: beforeInput, focus: focus, change: change, click: click, keydown: keydown, keyup: keyup, pointerdown: pointerdown, pointerup: pointerup };
  specs.forEach(function(spec) { MKXFORM.onChange(spec.ref, function(value) {
    if (!current()) return;
    var edit = pending[spec.ref], next;
    try { next = text(value === undefined ? MKXFORM.getValue(spec.ref) : value, spec); }
    catch (_) { if (edit) edit.conflict = true; schedule(); return; }
    if (edit && edit.conflict) { schedule(); return; }
    var last = settled[spec.ref], choice = pendingChoice[spec.ref];
    if (!edit && last) {
      var userDeselected = next.status === "none" && choice && choice.checked && choice.checked[spec.options.length] === false;
      if (!userDeselected && ((next.status === "other" && next.value !== last.value &&
          (next.value === last.previous || next.value === nativeText(last.value) || last.history.indexOf(next.value) >= 0)) || next.status === "none")) {
        pending[spec.ref] = { target: last.target, value: last.value, previous: last.previous, conflict: true, conflictReason: "late_native" };
        schedule(); return;
      }
      if (userDeselected || next.status === "other" && next.value !== last.value) delete settled[spec.ref];
    }
    var nativeEvent = edit && (edit.inputEvent && edit.inputEvent.eventPhase || edit.blurEvent && edit.blurEvent.eventPhase);
    if (edit && edit.composing && !nativeEvent && (next.status !== "other" || next.value !== edit.value)) edit.conflict = true;
    if (edit && !edit.composing && !nativeEvent && next.status === "none") {
      if (choice && choice.checked && choice.checked[spec.options.length] === false) { delete pending[spec.ref]; delete settled[spec.ref]; }
      else edit.conflict = true;
    }
    else if (edit && !edit.composing && !nativeEvent && next.status === "other" && next.value !== edit.value) {
      if (next.value === edit.previous) edit.conflict = true;
      else if (edit.history && edit.history.indexOf(next.value) >= 0) { schedule(); return; }
      else if (next.value === nativeText(edit.value)) edit.conflict = true;
      else delete pending[spec.ref];
    }
    schedule();
  }); });
  gate.check = function() {
    if (!current() || Object.keys(composing).length || !refresh()) return false;
    try { return specs.every(function(spec) {
        var value = text(MKXFORM.getValue(spec.ref), spec);
        var encoded = value.parts.join(","), weight = 0;
        for (var i = 0; i < encoded.length; i++) { var code = encoded.charCodeAt(i); weight += code <= 127 ? 1 : code <= 255 ? 2 : 3; }
        if (weight > 200 || !selectionSynchronized(spec, value)) return false;
        if (!(spec.otherRequired && value.status === "other" && value.value.trim() === "")) return true;
        var attr = MKXFORM.getFieldAttr(spec.ref);
        if (attr === 1 || attr === 4) return true;
        if (attr !== 2 && attr !== 3) return false;
        var all = document.querySelectorAll('[data-id="' + spec.ref + '"]');
        return all.length > 0 && roots(spec).length === 0;
      }); } catch (_) { return false; }
  };
  gate.ready = true;
  schedule();
}` };
  const actions = Array.isArray(scripts.actions) ? scripts.actions : [];
  const existing = actions.filter(candidate => candidate.id === action.id);
  if (existing.length) {
    if (existing.length === 1 && Object.keys(action).every(key => existing[0][key] === action[key]) &&
        Object.keys(existing[0]).length === Object.keys(action).length) return scripts;
    const error = new Error("Native Other display action identity is already occupied.");
    error.code = "projection.native_other_display.action_collision";
    throw error;
  }
  return { ...scripts, actions: [...actions, action] };
}
