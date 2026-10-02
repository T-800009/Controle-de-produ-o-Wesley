import {normalize,type Row} from './materials.ts';

export type AnaSource='KOB1'|'ZPP009'|'MM60'|'COOIS';
type Field={name:string;aliases:string[];required?:boolean};
export const anaAliases={
 op:['Ordem','Ordem de produção','Ordem de producao','OP','Order','Pro. No.','Production Order'],
 material:['Material','Material SAP No.','SAP No.','SAP','Código SAP','Código','Part Number'],
 kobDescription:['Texto breve material','Texto breve do material','Texto material','Descrição','Denominação objeto'],
 zppDescription:['Description','Descrição','Texto material','Texto breve material'],
 actual:['Qtd.total entrada','Qtd total entrada','Quantidade total entrada','QTY','Quantidade'],
 bom:['BOM QTY','Qtd BOM','Quantidade BOM','QTY BOM'],
 price:['Preço','Preco','Price','Valor unitário','Valor unitario'],
 reportValue:['Valor/MR','Val/MR','Val. na moeda do relatório','Val.in rep.cur.'],
 reportCurrency:['Moeda do relatório','Moeda relatório','Report currency'],
 transactionValue:['Valor/moed.transação','Valor/moeda transação','Valor na moeda da transação','Value in transaction currency'],
 transactionCurrency:['Moeda da transação','Moeda transação','Transaction currency'],
 inputCost:['Input Cost'],
 inputQuantity:['Actual input of raw material','Actual input of Raw material'],
 currency:['Moeda','Currency'],
 priceUnit:['Unidade preço','Unidade de preço','Price unit'],
 unit:['Unid.medida lançada','Unid.medida lançamento','Unid.medida de lançamento','Unidade de medida de lançamento','UMB','UM básica','Unidade','Unidade de medida'],
 costClass:['Classe de custo','Classe custo','Cost element'],
 costDescription:['Descr.classe custo','Descrição classe de custo','Denom.classe custo'],
 orderQuantity:['Quantidade da ordem','Qtd. ordem','Qtd ordem','Quantidade ordem'],
 supplied:['Qtd.fornecida','Qtd fornecida','Quantidade fornecida','Delivered quantity'],
 good:['Quantidade boa confirmada','Qtd. boa confirmada','Qtd boa confirmada','Confirmed good quantity'],
 statusUser:['Status do usuário','Status usuário','User status'],
 statusSystem:['Status do sistema','Status sistema','System status'],
 physical:['Finalizada física','Finalizado físico','Finalização física','Física finalizada','Chassi finalizado','Chassi finalizada','Concluída fisicamente','Concluído fisicamente','Concluída física','Physical complete','Physical completion','Physically complete']
};
const field=(name:string,aliases:string[],required=false):Field=>({name,aliases,required});
export const anaFields:Record<AnaSource,Field[]>={
 KOB1:[field('Ordem',anaAliases.op,true),field('Material',anaAliases.material,true),field('Qtd.total entrada',anaAliases.actual,true),field('Descrição',anaAliases.kobDescription),field('Unidade',anaAliases.unit),field('Classe de custo',anaAliases.costClass),field('Descrição de custo',anaAliases.costDescription),field('Valor/MR',anaAliases.reportValue),field('Moeda do relatório',anaAliases.reportCurrency),field('Valor/moed.transação',anaAliases.transactionValue),field('Moeda da transação',anaAliases.transactionCurrency)],
 ZPP009:[field('Ordem',anaAliases.op,true),field('Material',anaAliases.material,true),field('BOM QTY',anaAliases.bom,true),field('Descrição',anaAliases.zppDescription),field('Planning QTY',['Planning QTY']),field('Issued QTY',['Issued QTY']),field('Unidade',anaAliases.unit),field('Input Cost',anaAliases.inputCost),field('Actual input of raw material',anaAliases.inputQuantity),field('Moeda',anaAliases.currency)],
 MM60:[field('Material',anaAliases.material,true),field('Preço',anaAliases.price,true),field('Descrição',anaAliases.kobDescription),field('Unidade',anaAliases.unit),field('Moeda',anaAliases.currency),field('Unidade preço',anaAliases.priceUnit)],
 COOIS:[field('Ordem',anaAliases.op,true),field('Quantidade da ordem',anaAliases.orderQuantity),field('Qtd.fornecida',anaAliases.supplied),field('Quantidade boa confirmada',anaAliases.good),field('Status do usuário',anaAliases.statusUser),field('Status do sistema',anaAliases.statusSystem),field('Finalizada física',anaAliases.physical)]
};

/** Same header resolution in the Worker and browser. Column positions are never assumed. */
export function anaColumns(headers:unknown[],source:AnaSource){
 const normalized=headers.map(normalize);
 return anaFields[source].flatMap(definition=>{
  // Prefer the specific SAP field over generic fallbacks (e.g. a material's
  // description over the production-order description).
  let index=-1;
  for(const alias of definition.aliases){
   const matches=normalized.flatMap((value,i)=>value===normalize(alias)?[i]:[]);
   if(matches.length>1)throw Error(`A aba ${source} tem a coluna ${definition.name} repetida. Confira o cabeçalho.`);
   if(matches.length){index=matches[0];break;}
  }
  if(index<0){
   if(definition.required){
    const label=source==='ZPP009'&&definition.name==='Ordem'?'Pro. No. ou Ordem':source==='ZPP009'&&definition.name==='Material'?'SAP No. ou Material':definition.name;
    throw Error(`A aba ${source} precisa ter a coluna ${label}.`);
   }
   return [];
  }
  return [{name:String(headers[index]),field:definition.name,index}];
 });
}

/** Compile column names once per source instead of normalizing every key of every row. */
export function anaReader(rows:Row[],source:AnaSource){
 const first=rows.find(row=>Object.keys(row).length);
 const columns=first?anaColumns(Object.keys(first),source):[];
 const keys=new Map(columns.map(column=>[column.field,column.name]));
 return {
  header:(field:string)=>keys.get(field)||'',
  get:(row:Row,field:string):unknown=>{const key=keys.get(field);return key===undefined?null:row[key]??null;}
 };
}
