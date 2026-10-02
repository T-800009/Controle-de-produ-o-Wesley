import {normalize} from './materials.ts';

const fields = [
 {name:'Material', aliases:['Material','SAP','Código SAP','Código','Part Number'], required:true},
 {name:'Texto breve material', aliases:['Texto breve material','Texto breve do material','Descrição','Denominação'], required:false},
 {name:'Centro', aliases:['Centro','Plant','WERKS'], required:false},
 {name:'Depósito', aliases:['Depósito','Storage Location','SLoc','LGORT'], required:false},
 {name:'UM básica', aliases:['UM básica','UMB','Unidade','Unidade de medida básica','Base Unit of Measure'], required:true},
 {name:'Utilização livre', aliases:['Utilização livre','Qtd Livre','Quantidade','Estoque de utilização livre','Unrestricted','Unrestricted use'], required:true},
 {name:'Val.utiliz.livre', aliases:['Val.utiliz.livre','Valor Livre','Valor','Value Unrestricted'], required:false},
 {name:'Localização', aliases:['Localização','Locação'], required:false},
];

/** Resolve the SAP export by its labels. Never assume the tab extends to H. */
export function stockColumns(headers:unknown[],depot:string){
 const labels=headers.map(normalize);
 return fields.flatMap(field=>{
  const aliases=new Set(field.aliases.map(normalize));
  const positions=labels.flatMap((label,index)=>aliases.has(label)?[index]:[]);
  if(positions.length>1)throw Error(`A aba ${depot} tem mais de uma coluna de ${field.name}. Confira o cabeçalho.`);
  if(!positions.length){
   if(field.required)throw Error(`A aba ${depot} precisa ter a coluna ${field.name} na primeira linha.`);
   return [];
  }
  return [{name:field.name,index:positions[0]}];
 });
}
