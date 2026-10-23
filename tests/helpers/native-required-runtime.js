import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const fixture = new URL('../fixtures/executor/persistence/required-runtime/', import.meta.url);

/** Replay the captured native auth/attribute APIs; the form host only stores updates. */
export function nativeRequiredRuntime(config, scene = 'add') {
  const byKey = new Map();
  const byName = new Map();
  for (const model of config.dataModel) {
    for (const field of [...(model.fdType === 'detail' ? [model] : []), ...model.fdFields]) {
      if (!field.fdAttribute) continue;
      const node = JSON.parse(field.fdAttribute).config;
      if (!node) continue;
      byKey.set(node.key, node);
      byName.set(node.controlProps.name, node);
      byName.set(`${model.fdTableName}.${node.controlProps.name}`, node);
      if (model.fdType === 'detail' && field === model) {
        byName.set(model.dynamicProps?.detailFieldName || model.fdCode, node);
      }
    }
  }
  const host = {
    getFormConfig: key => byKey.get(key),
    updateFormItemProps(key, props) {
      const node = byKey.get(key);
      for (const [name, value] of Object.entries(props)) {
        if (name === 'labelProps') node.labelProps = {...node.labelProps, ...value};
        else node.controlProps[name] = value;
      }
    },
    updateFormItemOptions(key, options) {
      const node = byKey.get(key);
      node.options = {...node.options, ...options};
    }
  };
  const dependencies = {
    39155: {useMemo: fn => fn(), useCallback: fn => fn},
    41732: {controlIsDetail: node => /xform-(?:m-)?detail-table$/.test(node.type)},
    80536: {
      EShowStatus: {add:'add', edit:'edit', view:'view', readOnly:'readOnly'},
      EKind: {control:'control', container:'container'}
    },
    8655: {fmtMsg: (_key, fallback) => fallback},
    6992: {type2widget: type => ({isStored: !/description|detail-table/.test(type)})},
    89107: {isSensitiveValidateNeed: () => false},
    90405: {SensitiveComponents: []},
    99767: {useSensitive: () => ({validateSensitive() {}})},
    88055: {__esModule:true, default: copy},
    62383: {getConfig: name => byName.get(name)},
    68170: {$$form: () => host},
    12712: {isTwoFormRules:'isTwoFormRules'}
  };
  const context = vm.createContext({
    window:{APP_CONFIG:{}}, mk:{getUserConfig: () => 'zh-cn'}, console:{log() {}, error() {}}
  });
  function load(name) {
    context.module = {exports:{}};
    vm.runInContext(readFileSync(new URL(`${name}.cjs`, fixture), 'utf8'), context);
    const exports = {};
    context.module.exports({exports}, exports, id => {
      if (!dependencies[id]) throw new Error(`Unexpected captured native dependency ${id}`);
      return dependencies[id];
    });
    return exports;
  }
  const applyAuth = load('useAuth').useAuth.call({}, null, config.auth[0][scene], scene, false, 'desktop', {}, '');
  for (const node of byKey.values()) {
    if (node.kind === 'control') applyAuth(node, {desktop:[]}, {current:{}}, {});
  }
  for (const model of config.dataModel.filter(model => model.fdType === 'detail')) {
    const table = byName.get(model.fdTableName);
    table.controlProps.columns = model.fdFields.filter(field => !field.fdIsSystem)
      .map(field => byName.get(`${model.fdTableName}.${field.fdName}`));
  }
  const fieldAttr = load('setFieldAttr').default.body;
  const detailAttr = load('setDetailFieldAttr').default.body;
  const values = {};
  const MKXFORM = {
    viewStatus: scene,
    getValue: id => values[id],
    setValue: (id, value) => {values[id] = value;},
    setFieldAttr: (id, attribute) => fieldAttr(id, attribute, {}),
    setDetailFieldAttr: (id, attribute) => detailAttr(id, attribute, {})
  };
  return {
    MKXFORM,
    field(id) {return byName.get(id);},
    detailColumn(tableName, columnId) {
      return byName.get(tableName).controlProps.columns.find(column => column.controlProps.name === columnId);
    },
    required(id) {return isRequired(byName.get(id));},
    detailRequired(tableName, columnId) {
      return isRequired(this.detailColumn(tableName, columnId));
    }
  };
}

function isRequired(node) {
  return node?.options?.validateRules?.some(rule => typeof rule !== 'function' && rule.required === true) === true;
}

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, copy(value)])) : value;
}
