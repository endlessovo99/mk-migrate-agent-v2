import {cleanSourceFile,draftSourceDraft} from '../../src/translator/index.js';
import {attachMigrationPolicies,migrationPolicySourceDigest} from '../../src/translator/approved-migration-policies.js';
import {sha256Digest} from '../../src/agent-review/digest.js';
import {createTrustedMigrationDsl} from '../../src/dsl/trust.js';
import {remoteSelectorFixture} from '../fixtures/executor/remote-selector-resources.js';
import {FakeNewoaAdapter} from '../route-validation/fake-newoa-adapter.js';
export const remoteFixture='tests/fixtures/route-validation/approved-remote-policies/route-approved-remote_SysFormTemplate.xml';
export function remotePublicInput(){
 const raw=cleanSourceFile(remoteFixture),fields=[...raw.form.controls,...raw.form.dataFields,...raw.form.detailTables.flatMap(v=>v.columns)];
 const remotes=fields.filter(v=>v.sourceProps?.remoteSelectorSourceContract),resources=remotes.map((field,i)=>remoteSelectorFixture({id:'fixture_lookup_'+i,inputs:field.sourceProps.remoteSelectorSourceContract.inputMappings.map(mapping=>mapping.parameterName)}));
 const decisions=remotes.map((field,i)=>({...resources[i].decision,sourceRef:field.sourceRef,contractDigest:sha256Digest(field.sourceProps.remoteSelectorSourceContract),runtimeFactDigest:field.sourceProps.approvedRemoteSelectorSourceFact?.digest}));
 const source=attachMigrationPolicies(raw,{version:1,sourceDraftSha256:migrationPolicySourceDigest(raw),scope:{baseUrl:'https://qas.example.invalid',targetCategoryId:'route-category-id'},authorization:{actor:'synthetic-fixture-user',evidenceSha256:'sha256:'+'a'.repeat(64)},decisions});
 const draft=draftSourceDraft(source),dsl=createTrustedMigrationDsl(source,draft,{externalAgentReviewed:true,reviewerName:'synthetic-route-test-only'});
 return {raw,source,draft,dsl,decisions,resources};
}
export function fakeRemoteClient(resources,{onReadInterface,onGetReadback}={}){
 const client=new FakeNewoaAdapter('persist');client.baseUrl='https://qas.example.invalid';let reads=0;
 client.getTicInterface=async fdId=>{const fixture=resources.find(v=>v.nativeInterface.fdId===fdId);if(!fixture)throw Error('Fixture missing');const value=structuredClone(fixture.nativeInterface);return onReadInterface?onReadInterface(value,++reads):value;};
 client.getTicConnection=async fdId=>{const fixture=resources.find(v=>v.connection.fdId===fdId);if(!fixture)throw Error('Fixture missing');return structuredClone(fixture.connection);};
 const getInfo=client.getElementInfo.bind(client);client.getElementInfo=async(ids,opts)=>ids.every(v=>v==='fixture_caller')?ids.map(fdId=>({fdId,fdOrgType:8,fdIsAvailable:true})):getInfo(ids,opts);
 const getTemplate=client.getTemplate.bind(client);client.getTemplate=async id=>{const value=await getTemplate(id);return client.updated&&onGetReadback?onGetReadback(value):value;};
 const sequence=[];return new Proxy(client,{get(target,key){if(key==='sequence')return sequence;const value=Reflect.get(target,key);return typeof value==='function'?function(...args){sequence.push(String(key));return value.apply(target,args);}:value;}});
}
