/** A missing legacy connection is irrelevant only to an explicit closed SQL retirement. */
export function remoteOmissionContractEligible(contract){
 if(contract?.status==='static')return ['REST','SQL'].includes(contract.kind);
 return contract?.kind==='SQL'&&contract.status==='unproven'&&contract.reasons?.length===1&&
  contract.reasons[0]==='SQL_resource_or_query_unproven'&&contract.businessDataSource?.sourceId===''&&
  typeof contract.requestResource?.querySha256==='string'&&contract.requestResource.querySha256!=='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
}
