import {normalize} from './materials.ts';
export const sapKey=(value:unknown)=>normalize(String(value??'').trim().replace(/\.0+$/,''));
export const orderKey=(value:unknown)=>sapKey(value).replace(/^0+(?=\d)/,'');
export const movementKey=(material:unknown,op:unknown)=>JSON.stringify([sapKey(material),orderKey(op)]);
export const unitKey=(value:unknown)=>{const unit=sapKey(value);return ['pc','pcs','pce','ea','un','und'].includes(unit)?'pcs':['l','lt','lto','ltr'].includes(unit)?'l':unit;};
export type MovementEvidence={
 issued:number;reversed:number;net:number;count:number;duplicates:number;issue:string;
 depots:string[];units:string[];documents:{document:string;year:string;item:string;type:string;quantity:number|null;depot:string;date:string}[];
};
export function documentYear(value:unknown){const s=String(value??'');return s.match(/^(?:Date\()?((?:19|20)\d{2})[,-]/)?.[1]||s.match(/\b((?:19|20)\d{2})\b/)?.[1]||'';}
