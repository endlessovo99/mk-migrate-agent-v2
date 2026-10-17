import {MAIN_TABLE_PLACEHOLDER} from '../dsl/native-main-table-reference.js';

export const NATIVE_DATE_ONLY_TEXT_CONTRACT=Object.freeze({
 version:1,component:'@elem/xform-datetime',release:'S82LBQSE7',
 moduleSha256:'f6aeeb8238d51f411aae6c44c3f15a8b04adc15fb14bb7f6e758ba1cb8841280',
 rawPointUnit:'milliseconds',nativeEventOrder:'form change before action dispatch',format:'yyyy-MM-dd',
 textApi:'MKXFORM.getValueText(mainTable.field)',emptyProjection:'nullish-or-empty-string-only'
});
export function dateOnlyInputContract(field){
 const props=field?.sourceProps,fact=props?.mainStringValueBindingFact;
 return field?.type==='dateTime'&&field.componentId==='xform-datetime'&&field.dataOnly!==true&&
  field.sourceProps?.metadataAttributes?.type==='Date'&&field.sourceProps.metadataAttributes.name===field.id&&
  field.sourceProps?.designerValues?.businessType==='dateDialog'&&
  field.props?.displayPattern==='yyyy-MM-dd'&&[undefined,'yyyy-MM-dd'].includes(field.props?.dataPattern)&&field.props?.multiple!==true&&
  props.designerId===field.id&&props.metadataId===field.id&&props.metadataKind==='simple'&&fact?.version===1&&fact.fieldId===field.id&&fact.metadata?.count===1&&fact.metadata.type==='Date'&&fact.metadata.declarations?.length===1&&
  fact.surfaces?.designer?.logicalBindingCount===1&&fact.surfaces?.display?.logicalBindingCount===1&&['fdDesignerHtml','fdDisplayJsp','fdMetadataXml'].every(key=>/^[a-f0-9]{64}$/.test(fact.sourceHashes?.[key]||''));
}
/** Native point zero is a value. Native display text carries the configured calendar/timezone. */
export function nativeDateOnlyValueExpression(fieldId,rawExpression){
 if(typeof fieldId!=='string'||!/^fd_[A-Za-z0-9_]+$/.test(fieldId))throw new Error('A native date-only main field is required.');
 const raw=rawExpression||'MKXFORM.getValue('+JSON.stringify(fieldId)+')';
 return '(function(__datePoint){if(__datePoint===undefined||__datePoint===null||__datePoint==="")return "";'+
  'if(typeof __datePoint!=="number"&&typeof __datePoint!=="string"&&!(__datePoint instanceof Date))throw "Unsupported native DatePoint.";'+
  'var __dateText=MKXFORM.getValueText('+JSON.stringify(MAIN_TABLE_PLACEHOLDER+'.'+fieldId)+');'+
  'if(typeof __dateText!=="string")throw "Native date display text is unavailable.";'+
  'return __dateText;})('+raw+')';
}
