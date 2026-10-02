import {normalize} from './materials.ts';

const fields=[
 {name:'Ordem',aliases:['Ordem','Ordem de produção','Ordem de producao','OP','Order'],required:true},
 {name:'Material',aliases:['Material','SAP','Código SAP','Código','Part Number'],required:true},
 {name:'Quantidade',aliases:['Quantidade','Qtd.','Qtd','Quantity','Quantidade em UM básica','Qtd.em UM básica','Qtd. em UM básica'],required:true},
 {name:'Tipo de movimento',aliases:['Tipo de movimento','Tipo movimento','Tipo mov.','Tipo de mov.','Tipo movim.','Mov. tipo','TMv','Mvt','MvT','Movement type','Movement Type','Tipo de movimiento'],required:true},
 {name:'Centro',aliases:['Centro','Plant'],required:false},
 {name:'UM básica',aliases:['UM básica','UMB','Unidade de medida básica','Unidade','Base Unit of Measure'],required:false},
 {name:'Depósito',aliases:['Depósito','Storage location','SLoc'],required:false},
 {name:'Data do documento',aliases:['Data do documento','Document Date'],required:false},
 {name:'Data de lançamento',aliases:['Data de lançamento','Posting Date'],required:false},
 {name:'Doc.material',aliases:['Documento material','Doc.material','Documento de material','Material Document'],required:false},
 {name:'Ano doc.material',aliases:['Ano doc.material','Ano do documento material','Ano do documento','Material Doc. Year'],required:false},
 {name:'Item doc.material',aliases:['Item doc.material','Item do documento material','Item material document','Material Doc.Item'],required:false},
 {name:'Chave material + OP',aliases:['NEW COD','New Cod','Chave material OP','Chave material + OP','Material + Ordem','Material/Ordem'],required:false},
];

export function mb51Columns(headers:unknown[]){
 return fields.flatMap(field=>{
  const aliases=field.aliases.map(normalize);
  const matches=headers.flatMap((h,i)=>aliases.includes(normalize(h))?[i]:[]);
  if(!matches.length){if(field.required)throw Error(`A aba MB51 não contém a coluna ${field.name} na primeira linha. Inclua esse campo na exportação do SAP, mantendo os valores originais.`);return [];}
  if(matches.length>1)throw Error(`A aba MB51 contém mais de uma coluna para ${field.name}. Use um cabeçalho único para evitar ambiguidade.`);
  return [{name:field.name,index:matches[0]}];
 });
}

export function columnLetter(index:number){
 let n=index+1,out='';
 while(n){const remainder=(n-1)%26;out=String.fromCharCode(65+remainder)+out;n=Math.floor((n-1)/26);}
 return out;
}
