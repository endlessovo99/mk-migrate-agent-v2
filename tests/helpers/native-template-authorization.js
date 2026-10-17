/** Independent fake of the native permission contract, not a request echo. */
export function materializeNativeTemplateAuthorization(template,{everyone,templateEmptyNotUse}={}){
 if(!Array.isArray(template?.fdReaders)||!Array.isArray(template?.fdEditors))return;
 const unique=members=>[...new Map(members.map(m=>[m.fdId,structuredClone(m)])).values()];
 template.fdAllEditors=unique(template.fdEditors);
 if(template.fdReaders.length){template.fdAllReaders=unique([...template.fdReaders,...template.fdEditors]);return;}
 if(templateEmptyNotUse==='true')throw new Error('The native empty-deny aggregate is not evidenced by this fixture contract.');
 if(!everyone?.fdId)throw new Error('Native everyone identity is unavailable.');
 template.fdAllReaders=[{fdId:everyone.fdId,fdName:everyone.fdName}];
}
