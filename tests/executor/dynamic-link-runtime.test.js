import assert from 'node:assert/strict';
import {it} from 'node:test';
import {NewoaClient} from '../../src/executor/newoa-client.js';
import {DYNAMIC_LINK_RUNTIME} from '../../src/executor/dynamic-link-runtime.js';

it('hashes the exact registry-versioned native asset and rejects arbitrary asset paths',async()=>{
 const calls=[],client=new NewoaClient({baseUrl:DYNAMIC_LINK_RUNTIME.origin,fetchImpl:async(url)=>{calls.push(url);return {ok:true,arrayBuffer:async()=>new TextEncoder().encode('fixture')}}});
 await client.getDynamicLinkAssetSha256({assetPath:'sys/artifact/elements/xform-button/index.js'});
 assert.equal(calls[0],DYNAMIC_LINK_RUNTIME.origin+'/web/sys/artifact/elements/xform-button/index.js?PQTu74yATD');
 await assert.rejects(client.getDynamicLinkAssetSha256({assetPath:'sys/artifact/elements/xform-button/index.js?other'}));assert.equal(calls.length,1);
});
