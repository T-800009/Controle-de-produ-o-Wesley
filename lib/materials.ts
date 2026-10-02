import type {MovementEvidence} from './mb51-evidence.ts';
import {stockModule} from './stock-modules.ts';
export type Row = Record<string, any>;
export type Dataset = {id:string; name:string; revision:string; rows:Row[]; ops?:string[]; source:string; updatedAt?:string; version?:string; reviewRequired?:boolean; sheetId?:string; sheetName?:string; mb51Evidence?:Record<string,MovementEvidence>; mb51Mode?:'movement-type'; mb51OrderCoverage?:Record<string,number>; coois?:Row[]; cooisSource?:string; scrap?:Row[]; scrapSource?:string};
export const SHEET_ID='1E36Lf79omaeXrk2etiSdKJRVCtJbeYdYR5gnaOwAMQE';
export const normalize=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function number(v:unknown):number|null {if(v===null||v===undefined||v==='')return null;if(typeof v==='number')return Number.isFinite(v)?v:null;let s=String(v).trim().replace(/R\$|\s/g,'');if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');return s!==''&&Number.isFinite(Number(s))?Number(s):null;}
export function pick(r:Row,keys:string[]){const k=Object.keys(r).find(k=>keys.some(x=>normalize(x)===normalize(k)));return k===undefined?'':r[k]??'';}
export function convert(rows:Row[],kind:string){
 const out:Row[]=[]; const ops=new Set<string>();
 for(const [i,r] of rows.entries()){
  const material=String(pick(r,['Material','Código','SAP','Part Number'])).trim();if(!material)continue;
  const description=String(pick(r,['Texto breve material','Texto breve do material','Descrição','Denominação']));
  const unit=String(pick(r,['UMB','UM básica','Unidade']));
  const base={id:String(i+2),material,description,unit};
  if(kind==='consumo'){
   const consumption:Row={};for(const k of Object.keys(r)){if(/^\d{8,}$/.test(k.trim())){ops.add(k.trim());consumption[k.trim()]=number(r[k]);}}
   out.push({...base,item:String(pick(r,['ITEM BOM SAP'])),classification:String(pick(r,['CLASSIFICAÇÃO'])),required:number(pick(r,['Qtd.necessária','Quantidade necessária','Qtd por ônibus'])),consumption});
  }else out.push({...base,center:String(pick(r,['Centro'])),depot:stockModule(kind)?.depot??String(pick(r,['Depósito','Storage Location','SLoc','LGORT'])).trim().replace(/\.0+$/,''),quantity:number(pick(r,['Utilização livre','Qtd Livre','Quantidade'])),value:number(pick(r,['Val.utiliz.livre','Valor Livre','Valor'])),location:String(pick(r,['Localização','Locação']))});
 }
 return {rows:out,ops:[...ops]};
}
export function validateRows(rows:Row[],kind:string){if(!rows.length)throw Error('Nenhuma linha com código de material foi encontrada.');if(kind==='consumo'&&(!rows.some(r=>typeof r.required==='number'&&Number.isFinite(r.required))||!rows.some(r=>String(r.unit??'').trim())||!rows.some(r=>Object.keys(r.consumption??{}).some(k=>/^\d{8,}$/.test(k)))))throw Error('Base incompatível com BOM × OP: faltam quantidades previstas, unidades ou colunas de OP. Confira se a fonte é uma BOM, e não uma lista de movimentos SAP.');for(const r of rows){if(!String(r.material??'').trim())throw Error('Existe uma linha sem código SAP.');if(kind==='consumo'){if(r.required!==null&&(!Number.isFinite(r.required)||r.required<0))throw Error('Quantidade da BOM inválida.');for(const v of Object.values(r.consumption??{}))if(v!==null&&!Number.isFinite(v))throw Error('Consumo inválido.');}else{if(r.quantity!==null&&!Number.isFinite(r.quantity))throw Error('Quantidade inválida.');if(r.value!==null&&!Number.isFinite(r.value))throw Error('Valor inválido.');}}}
