import {normalize,type Row} from './materials.ts';
import {convertScrap,diagnoseScrap,indexScrap,type ScrapIndex,type ScrapRecord} from './scrap.ts';
const canonical=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));
export function consumptionOf(row:Row, selectedOps:string[],scrapRows:Row[]=[],scrapRecords?:ScrapRecord[],scrapIndex?:ScrapIndex){
 const values=selectedOps.map(op=>row.consumption?.[op]);
 const known=values.filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
 const records=scrapRecords||convertScrap(scrapRows);
 const indexed=scrapIndex||indexScrap(records);
 const scrapByOp=selectedOps.reduce((sum,op)=>{const diagnosis=diagnoseScrap({material:row.material,op},records,indexed);return sum+(diagnosis.scrapAdjustment??diagnosis.scrapQuantity??0);},0);
 const raw=known.length?known.reduce((a,b)=>a+b,0):null;
 return {net:raw===null?null:raw+scrapByOp,raw,scrap:scrapByOp,complete:values.length>0&&known.length===values.length};
}
export function summarizeUsage(rows:Row[],ops:string[],scrapRows:Row[]=[],scrapRecords?:ScrapRecord[],scrapIndex?:ScrapIndex){
 // Repeated BOM lines must not double-count the same material/OP consumption.
 const materials=new Map<string,Row[]>();for(const r of rows){const k=JSON.stringify([canonical(r.material),canonical(r.unit)]);const group=materials.get(k);if(group)group.push(r);else materials.set(k,[r]);}
 const records=scrapRecords||convertScrap(scrapRows);
 const indexed=scrapIndex||indexScrap(records);
 let used=0,unused=0,reversed=0,unknown=0;const units=new Map<string,number>();
 for(const group of materials.values()){
  const merged:Row={material:group[0].material,unit:group[0].unit,consumption:{}};
  for(const op of ops){const candidates=[...new Set(group.map(r=>r.consumption?.[op]).filter(v=>typeof v==='number'&&Number.isFinite(v)))];merged.consumption[op]=candidates.length===1?candidates[0]:null;}
  const {net,complete}=consumptionOf(merged,ops,[],records,indexed);
  if(!complete||net===null){unknown++;continue;}
  if(net>0)used++;else if(net===0)unused++;else reversed++;
  const unit=String(group[0].unit||'Sem UM');units.set(unit,(units.get(unit)||0)+net);
 }
 return {used,unused,reversed,unknown,materials:materials.size,units:[...units].sort((a,b)=>a[0].localeCompare(b[0]))};
}
