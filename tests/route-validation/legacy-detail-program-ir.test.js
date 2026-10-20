import assert from "node:assert/strict";
import { it } from "node:test";
import vm from "node:vm";
import { compileLegacyDetailProgramIR, createLegacyDetailProgramRuntime } from "../../src/translator/legacy-detail-program-ir.js";

const scripts = [
  { gate: "edit", source: `
function updateRow(value, index) {
  var element = document.getElementsByName("detail."+index+".notes")[0];
  element.setAttribute("validate", "old helper");
}
AttachXFormValueChangeEventById("category", function(value, elements) {
  updateRow(value, 0);
});
` },
  { source: `
function updateRow(value, index) {
  var element = document.getElementsByName("detail."+index+".notes")[0];
  if (value=="replace") {
    element.value="true";
    element.style.display="";
    element.setAttribute("placeholder","Replacement details");
    element.setAttribute("validate","required");
  } else {
    element.value="";
    element.style.display="none";
    element.setAttribute("validate","");
    cleanup();
  }
}
function cleanup() {
  var spans=document.getElementsByTagName("span");
  for(var i=0;i<spans.length;i++) {
    if(spans[i].innerHTML=="Replacement details") {
      spans[i].parentNode.style.display="none";
    }
  }
}
Com_AddEventListener(window,"load",function() {
  var table=document.getElementById("TABLE_DL_detail");
  for(var i=0;i<table.rows.length-2;i++) {
    updateRow("replace",i);
  }
});
` }
];

function harness(input = scripts, enabledGates = ["edit"]) {
  const effects = [], callbacks = new Map(), loads = [], values = new Map();
  let runtime;
  const node = name => {
    if (!values.has(name)) values.set(name, { value: "", display: "", placeholder: "", validate: "" });
    return runtime.createHandle("node", name);
  };
  const host = {
    call(name, args) {
      if (name === "AttachXFormValueChangeEventById") callbacks.set(args[0], args[1]);
      else if (name === "Com_AddEventListener") loads.push(args[2]);
      else throw new Error(`Unmodeled global ${name}`);
    },
    method(handle, method, args) {
      if (handle.kind === "document" && method === "getElementById") return runtime.createHandle("table", args[0]);
      if (handle.kind === "document" && method === "getElementsByName") return [node(args[0])];
      if (handle.kind === "document" && method === "getElementsByTagName") return [runtime.createHandle("span", "span")];
      if (method === "setAttribute") { values.get(handle.key)[args[0]] = args[1]; effects.push([handle.key, ...args]); return undefined; }
      throw new Error(`Unmodeled method ${method}`);
    },
    get(handle, property) {
      if (property === "rows") return [null, null, null, null];
      if (property === "style") return runtime.createHandle("style", handle.key);
      if (property === "parentNode") return node("span-parent");
      if (property === "innerHTML") return "Replacement details";
      if (property === "value") return values.get(handle.key).value;
      throw new Error(`Unmodeled read ${property}`);
    },
    set(handle, property, value) { values.get(handle.key)[property] = value; effects.push([handle.key, property, value]); }
  };
  const ir = compileLegacyDetailProgramIR(input);
  runtime = createLegacyDetailProgramRuntime(JSON.parse(JSON.stringify(ir)), host);
  runtime.run({ enabledGates });
  return { ir, runtime, effects, callbacks, loads, values };
}

it("compiles the complete ordered scripts and inventories every host operation without claiming a DOM proof", () => {
  const { ir } = harness();
  assert.equal(ir.scripts.length, 2);
  assert.equal(ir.requiresHostProof, true);
  assert.deepEqual(ir.hostRequirements.writes, ["display", "value"]);
  assert.deepEqual(ir.hostRequirements.attributes, ["placeholder", "validate"]);
  assert.ok(ir.hostRequirements.reads.includes("parentNode"));
});

it("resolves earlier callbacks against the final global helper and preserves every repeated event effect", () => {
  const { runtime, callbacks, effects, values, loads } = harness();
  runtime.invoke(loads[0]);
  runtime.invoke(callbacks.get("category"), ["replace", []]);
  const first = effects.length;
  runtime.invoke(callbacks.get("category"), ["replace", []]);
  assert.equal(effects.length - first, 4);
  runtime.invoke(callbacks.get("category"), ["new", []]);
  assert.equal(values.get("detail.0.notes").placeholder, "Replacement details");
  assert.equal(values.get("detail.0.notes").validate, "");
  assert.equal(values.get("span-parent").display, "none");
  assert.equal(values.get("detail.1.notes").validate, "required");
  assert.ok(effects.every(effect => effect[2] !== "old helper"));
});

it("uses caller gates and accepts renamed helpers, variables, fields, and labels", () => {
  const renamed = scripts.map(script => ({ ...script, source: script.source.replaceAll("updateRow", "rewriteLine").replaceAll("element", "control").replaceAll('"detail.', '"equipment.').replaceAll("TABLE_DL_detail", "TABLE_DL_equipment").replaceAll("Replacement", "Renewal") }));
  const { runtime, callbacks, loads, values } = harness(renamed, []);
  assert.equal(callbacks.size, 0);
  runtime.invoke(loads[0]);
  assert.equal(values.get("equipment.0.notes").placeholder, "Renewal details");
});

it("matches JavaScript function/var hoisting, primitive equality, closure scope, and script order", () => {
  const source = `
var answer=before();
function before(){return final();}
function final(){return 1;}
function final(){return 7;}
function local(value){if(value){var hidden=8;} return hidden;}
var noValue=local(false);
var earlier=final;
function wrapper(){var local=9;return function(){return local;};}
var captured=wrapper();
var zero=(null==null) && (""==0);
`;
  const second = "function final(){return 11;} var late=before(); var old=earlier(); var capture=captured();";
  const context = vm.createContext({});
  vm.runInContext(source, context); vm.runInContext(second, context);
  const runtime = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source }, { source: second }]), {});
  runtime.run();
  for (const key of ["answer", "noValue", "zero", "late", "old", "capture"]) assert.equal(runtime.read(key), context[key], key);
});

it("keeps implicit globals private and does not initialize them before their first assignment", () => {
  const runtime = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source: "function set(){shared=4;} function get(){return shared;}" }]), {});
  runtime.run();
  assert.throws(() => runtime.invoke("get"), /unbound variable/);
  runtime.invoke("set");
  assert.equal(runtime.invoke("get"), 4);
  assert.equal(Object.hasOwn(globalThis, "shared"), false);
});

it("rejects script and function strict directives rather than changing implicit assignment semantics", () => {
  for (const source of [
    '"use strict"; function event(){legacyImplicit=1;}',
    'function event(){"use strict";legacyImplicit=1;}'
  ]) {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    assert.throws(() => vm.runInContext("event()", context), /legacyImplicit is not defined/);
    assert.throws(() => compileLegacyDetailProgramIR([{ source }]), /strict-mode directives/);
  }
});

it("does not evaluate method arguments after a nullish property lookup fails", () => {
  for (const initializer of ["", "=null"]) {
    const source = `var effects=0;var missing${initializer};
      function effect(){effects=effects+1;return "hint";}
      function event(){missing.setAttribute("placeholder",effect());}`;
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const runtime = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source }]), {});
    runtime.run();
    assert.throws(() => vm.runInContext("event()", context), /Cannot read properties/);
    assert.throws(() => runtime.invoke("event"), /nullish method receiver/);
    assert.equal(context.effects, 0);
    assert.equal(runtime.read("effects"), 0);
  }
});

it("inventories inline handler strings without executing or silently discarding them", () => {
  const ir = compileLegacyDetailProgramIR([{ source: `var target=document.getElementById("field");target.setAttribute("onclick","DocList_AddRow();");` }]);
  assert.equal(ir.hostRequirements.inlineHandlers.length, 1);
  assert.deepEqual(ir.hostRequirements.inlineHandlers[0].expression, ["literal", "DocList_AddRow();"]);
  assert.deepEqual(ir.hostRequirements.globals, []);
});

for (const source of [
  "fetch('https://example.test');",
  "var value=document.cookie;",
  "var value=document['constructor'];",
  "var value=document.constructor;",
  "var value=document.getElementById('x');value.innerHTML='unsafe';",
  "var value=document.getElementById('x');value.setAttribute('src','https://example.test');",
  "var value=document.getElementById('x');value.setAttribute('onchange','unknown()');",
  "var value=document.getElementById('x');value.remove();",
  "var key='constructor';var value=document[key];",
  "while(true){}",
  "for(var i=0;i<10001;i++){}",
  "for(var i=0;i<10;i++){i=0;}",
  "for(var i=0;i<10;i++){var i=1;}",
  "var location='https://example.test';",
  "function work(){return process.env;}",
  "if(true){function hidden(){}}"
]) it(`rejects unsupported effects or unsafe syntax: ${source.slice(0, 65)}`, () => {
  assert.throws(() => compileLegacyDetailProgramIR([{ source }]));
});

it("cannot reach arbitrary host object members through a dynamic collection key", () => {
  const ir = compileLegacyDetailProgramIR([{ source: "var key='constructor';var values=document.getElementsByName('x');var value=values[key];" }]);
  const runtime = createLegacyDetailProgramRuntime(ir, { method() { return []; } });
  assert.throws(() => runtime.run(), /invalid collection index/);
});

it("rejects unbranded host values, accessors, callable escapes, and mutated property IR", () => {
  const source = "var value=document.getElementById('x').value;";
  const ir = compileLegacyDetailProgramIR([{ source }]);
  const runtime = createLegacyDetailProgramRuntime(ir, { method() { return { value: "secret" }; } });
  assert.throws(() => runtime.run(), /unbranded/);
  const list = [];
  Object.defineProperty(list, "0", { get() { throw new Error("getter invoked"); } });
  const getterRuntime = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source: "var x=document.getElementsByName('x');" }]), { method() { return list; } });
  assert.throws(() => getterRuntime.run(), /accessor collection/);
  const escaped = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source: "common_dom_row_set_show_required_reset(function(){},true,true,false);" }]), { call() { assert.fail("callback must not escape"); } });
  assert.throws(() => escaped.run(), /callback escapes/);
  const tampered = JSON.parse(JSON.stringify(ir));
  tampered.scripts[0].body[0][1][0][1][2][1] = "constructor";
  let guarded;
  guarded = createLegacyDetailProgramRuntime(tampered, { method() { return guarded.createHandle("node", "x"); }, get() { assert.fail("unknown property reached host"); } });
  assert.throws(() => guarded.run(), /unsupported property/);
});

it("bounds collection loops and recursive calls independently, preserving break and continue", () => {
  const source = "var total=0;for(var i=0;i<10;i++){if(i==1){continue;}if(i==4){break;}total=total+i;}";
  const ir = compileLegacyDetailProgramIR([{ source }]);
  const runtime = createLegacyDetailProgramRuntime(ir, {}); runtime.run();
  assert.equal(runtime.read("total"), 5);
  assert.throws(() => createLegacyDetailProgramRuntime(ir, {}, { maxLoopIterations: 2 }).run(), /loop iteration budget/);
  assert.throws(() => createLegacyDetailProgramRuntime(ir, {}, { maxSteps: 2 }).run(), /step budget/);
  const recursive = createLegacyDetailProgramRuntime(compileLegacyDetailProgramIR([{ source: "function recurse(){recurse();}" }]), {}, { maxCallDepth: 4 });
  recursive.run();
  assert.throws(() => recursive.invoke("recurse"), /call depth budget/);
});
