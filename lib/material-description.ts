import {materialDescriptions} from '../data/material-descriptions.ts';
const foreign=(value:string)=>/[\u3400-\u9fff]/.test(value)||/\b(?:ASSEMBLY|FRONT FRAME|REAR FRAME|ELECTRIC BUS|AIR COMPRESSOR|BRAKE INTERLOCK|ROOF BATTERY FRAME|HOSE|PIPE)\b/i.test(value);
export type MaterialDescription={text:string;original:string;source:string;translated:boolean;untranslated:boolean};
/** Display only. Never modifies the material key, quantities or source text. */
export function materialDescription(material:string,original:string,mm60=''):MaterialDescription{
 const raw=original.trim(),known=materialDescriptions[material.trim().toUpperCase()];
 let text=raw,source='Descrição do export';
 if(mm60.trim()&&!foreign(mm60)){text=mm60.trim();source='Descrição SAP · MM60 desta leitura';}
 else if((!raw||foreign(raw))&&known){text=known.pt;source=known.source;}
 return {text:text||'Sem descrição',original:raw,source,translated:!!raw&&text!==raw,untranslated:foreign(text)};
}
