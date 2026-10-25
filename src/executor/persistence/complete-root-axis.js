// Map every retained cell of a proved physical root to one adaptive column axis,
// including mixed cells and collapsed rowspan groups. Reject incomplete proof.
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const integer = n => Number.isInteger(n) && n >= 0;
const ids = c => Array.isArray(c.refIds) ? c.refIds : c.refId ? [c.refId] : [];
const unique = (items,key) => {const m=new Map();for(const x of items){const k=key(x);if(!k||m.has(k))throw Error('duplicate-or-missing-reference');m.set(k,x);}return m;};
export function completeRootAxis(projected,nodes,sourceGrid,fields=[],mobile=false){
  const reject = (reason,details={}) => ({admitted:false,reason,...details,projected});
  if(mobile) return reject('mobile-unchanged');
  const proof=sourceGrid?.rootTable;
  if(sourceGrid?.source!=='fdDesignerHtml'||proof?.kind!=='standard-table'||proof.version!==1||!integer(proof.rowCount)||proof.rowCount<2||Object.keys(proof).length!==3)return reject('no-proved-physical-root');
  try {
    const sources=sourceGrid.rows||[],sr=unique(sources,s=>s.sourceRef),nm=unique(nodes,n=>n.id),pr=unique(projected,p=>p.id),fm=unique(fields,f=>f.id);
    const nodeByRef=unique(nodes,n=>n.sourceRef);
    const referenced=new Set(nodes.flatMap(n=>(n.children||[]).filter(c=>c.refType==='layout').flatMap(ids)));
    const roots=nodes.filter(n=>!referenced.has(n.id)).map(n=>({node:n,source:sr.get(n.sourceRef),projected:pr.get(n.id)})).filter(x=>/^(0|[1-9]\d*)$/.test(String(x.source?.sourceRow))&&Number(x.source.sourceRow)<proof.rowCount);
    if(!roots.length||roots.some(x=>!x.projected))return reject('physical-root-projection-missing');
    const axis=roots[0].source.columns;
    if(!integer(axis)||axis<2||roots.some(x=>x.source.columns!==axis))return reject('inconsistent-declared-root-axis',{rootAxes:roots.map(x=>[x.source.sourceRow,x.source.columns])});
    const physical=sources.filter(s=>/^(0|[1-9]\d*)$/.test(String(s.sourceRow))&&Number(s.sourceRow)<proof.rowCount);
    if(physical.length!==proof.rowCount||new Set(physical.map(s=>Number(s.sourceRow))).size!==proof.rowCount)return reject('physical-row-coverage-incomplete');
    const signatures=[];
    for(const {source:s}of roots){
      const cells=[...(s.cells||[])].sort((a,b)=>a.column-b.column);let next=0,weights=[];
      if(cells.some(c=>c.references?.some(r=>r.referenceType==='layout')||(c.rowspan||1)!==1||c.column!==next||c.evidence?.widthWeight!==c.widthWeight||(next=c.column+c.colspan,!Number.isFinite(c.widthWeight)||c.widthWeight<=0)))continue;
      if(next!==axis)continue;
      for(const c of cells)for(let j=0;j<c.colspan;j++)weights.push(c.widthWeight/c.colspan);
      const total=weights.reduce((a,b)=>a+b,0);signatures.push({sourceRow:s.sourceRow,partition:JSON.stringify(cells.map(c=>[c.column,c.colspan])),values:weights.map(x=>Math.round(x/total*1e12)/1e12)});
    }
    const partitions=[...new Set(signatures.map(x=>x.partition))];
    if(!partitions.some(p=>new Set(signatures.filter(x=>x.partition===p).map(x=>JSON.stringify(x.values))).size>1))return reject('no-conflicting-complete-preferences',{axis,signatures});
    const usedPhysical=new Set(),mapped=[];
    for(const entry of roots){
      // A single full-width detail table has only the root's two outer boundaries.
      // Leave its existing projection byte-for-byte intact; do not touch its own
      // independent column axis or its source content-flow/BR evidence.
      const only=entry.source.cells?.[0], own=entry.node.children?.[0], pc=entry.projected.cells?.[0];
      if(entry.source.cells?.length===1&&entry.node.children?.length===1&&entry.projected.cells?.length===1&&
          only.column===0&&only.colspan===axis&&only.references?.length===1&&only.references[0].referenceType==='detailTable'&&
          own.refType==='detailTable'&&equal(ids(own),[only.references[0].referenceId])&&own.sourceRef===only.sourceRef&&
          pc.column===0&&pc.colspan===entry.projected.columns&&equal(pc.refIds,ids(own))){
        usedPhysical.add(Number(entry.source.sourceRow));
        mapped.push({...entry.projected,sourceRow:entry.source.sourceRow,axisCoverage:'opaque-full-span'});
        continue;
      }
      const leaves=new Map(),seen=new Set();
      function inspect(node,start,span,ancestors){
        if(seen.has(node.id))throw Error('layout-cycle-or-reused-region:'+node.id);seen.add(node.id);
        const source=sr.get(node.sourceRef);if(!source)throw Error('source-region-missing:'+node.id);
        if(source.columns!==span)throw Error('independent-or-rescaled-child-axis:'+node.id);
        if(/^(0|[1-9]\d*)$/.test(String(source.sourceRow)))usedPhysical.add(Number(source.sourceRow));
        const cells=source.cells||[],byRef=unique(cells,c=>c.sourceRef);
        const occupied=new Set();
        for(const c of cells){
          if(!integer(c.column)||!Number.isInteger(c.colspan)||c.colspan<1||c.column+c.colspan>span||c.evidence?.column!==c.column||c.evidence?.colspan!==c.colspan||String(c.evidence?.row)!==String(source.sourceRow))throw Error('unproved-source-cell-geometry:'+c.id);
          for(let j=c.column;j<c.column+c.colspan;j++){if(occupied.has(j))throw Error('source-cell-overlap:'+c.id);occupied.add(j);}
        }
        const consumed=new Set();
        for(const child of node.children||[]){
          let pieces=[byRef.get(child.sourceRef)].filter(Boolean),f=ids(child).length===1?fm.get(ids(child)[0]):null,fold=f?.sourceProps?.foldedCaption;
          if(fold){
            pieces=[byRef.get(fold.captionCellSourceRef),byRef.get(fold.fieldCellSourceRef)];
            if(pieces.some(x=>!x)||pieces[0].column+pieces[0].colspan!==pieces[1].column||fold.referenceMap?.sourceRowRef!==source.sourceRef||pieces[0].references?.length!==1||pieces[0].references[0].referenceId!==fold.id||pieces[1].references?.length!==1||pieces[1].references[0].referenceId!==f.id||child.column!==pieces[0].column||child.colspan!==pieces.reduce((a,c)=>a+c.colspan,0)||f.props?.hiddenLabel===true)throw Error('folded-caption-map-unproved:'+child.id);
          }
          if(!pieces.length)throw Error('cell-source-reference-missing:'+child.id);
          for(const c of pieces){if(consumed.has(c.sourceRef))throw Error('source-cell-reused:'+c.id);consumed.add(c.sourceRef);}
          const first=pieces[0],width=pieces.reduce((a,c)=>a+c.colspan,0),refs=pieces.flatMap(c=>c.references||[]);
          // Existing native caption contract: an intrinsic title may consume at most half its editor cell.
          if(fold&&pieces[0].colspan/width>0.5)throw Error('native-folded-caption-share-exceeds-half:'+child.id);
          const bounds={column:start+first.column,colspan:width};
          if(child.refType==='layout'){
            if(pieces.length!==1||refs.length<2||refs.some(r=>r.referenceType!=='layout')||!cells.some(c=>c!==first&&c.rowspan===refs.length&&c.evidence?.rowspan===c.rowspan))throw Error('independent-nested-table-or-unproved-rowspan:'+child.id);
            const targets=ids(child).map(id=>nm.get(id));
            if(targets.some((t,i)=>!t||t.sourceRef!==refs[i]?.sourceRef))throw Error('rowspan-child-order-mismatch:'+child.id);
            for(const t of targets)inspect(t,bounds.column,bounds.colspan,[...ancestors,node.id]);
            continue;
          }
          const expected=fold?[f.id]:refs.map(r=>r.referenceId);
          if(!['field','detailTable'].includes(child.refType)||refs.some(r=>!['control','detailTable'].includes(r.referenceType))||!equal(ids(child),expected))throw Error('leaf-membership-unproved:'+child.id);
          if(!fold&&first.contentFlow&&!equal(child.contentFlow,first.contentFlow))throw Error('leaf-content-flow-changed:'+child.id);
          if(leaves.has(child.id))throw Error('duplicate-leaf:'+child.id);
          leaves.set(child.id,{...bounds,refIds:ids(child),ownerNodeId:node.id,ownerNodePath:[...ancestors,node.id],...(fold?{captionWidth:String(pieces[0].colspan/width*100)+'%'}:{})});
        }
        if(consumed.size!==cells.length)throw Error('unmapped-source-cell:'+source.sourceRow);
      }
      inspect(entry.node,0,axis,[]);
      const seenLeaves=new Set(),cells=[];
      for(const c of entry.projected.cells){const m=leaves.get(c.id);if(!m||seenLeaves.has(c.id)||!equal(c.refIds,m.refIds)||c.ownerNodeId!==m.ownerNodeId||!equal(c.ownerNodePath,m.ownerNodePath))throw Error('projected-leaf-map-unproved:'+c.id);seenLeaves.add(c.id);cells.push({...c,column:m.column,colspan:m.colspan,...(m.captionWidth?{captionWidth:m.captionWidth}:{})});}
      if(seenLeaves.size!==leaves.size)throw Error('projected-leaf-missing:'+entry.node.id);
      for(let row=0;row<entry.projected.rows;row++){const occupied=new Set();for(const c of cells.filter(c=>c.row<=row&&row<c.row+c.rowspan)){if(c.column<0||c.colspan<1||c.column+c.colspan>axis)throw Error('output-axis-boundary-invalid');for(let i=c.column;i<c.column+c.colspan;i++){if(occupied.has(i))throw Error('output-cell-overlap');occupied.add(i);}}}
      mapped.push({id:entry.node.id,sourceRow:entry.source.sourceRow,rows:entry.projected.rows,columns:axis,cells,colsStyle:[{startIndex:0,count:axis,value:'minmax(0, 1fr)'}]});
    }
    if(usedPhysical.size!==proof.rowCount)return reject('physical-row-mapping-not-closed',{axis,usedRows:[...usedPhysical].sort((a,b)=>a-b)});
    const byId=new Map(mapped.map(x=>[x.id,x]));
    return{admitted:true,axis,physicalRows:proof.rowCount,rootGroups:mapped.length,signatures,mapped,projected:projected.map(p=>{const r=byId.get(p.id);return r?{...p,columns:r.columns,cells:r.cells,colsStyle:r.colsStyle}:p;})};
  }catch(e){return reject('proof-failed',{detail:e.message});}
}
