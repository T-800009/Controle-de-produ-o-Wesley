import {normalize,number,pick,type Row} from './materials.ts';

const text=(value:unknown)=>String(value??'').trim();
const aliases={
 op:['Ordem','Ordem de produção','OP','Order'],
 orderQuantity:['Quantidade da ordem','Qtd. ordem','Qtd ordem','Quantidade ordem','Order quantity'],
 supplied:['Qtd.fornecida','Qtd fornecida','Quantidade fornecida','Delivered quantity'],
 good:['Quantidade boa confirmada','Qtd. boa confirmada','Qtd boa confirmada','Confirmed good quantity'],
 statusUser:['Status do usuário','Status usuário','User status'],
 statusSystem:['Status do sistema','Status sistema','System status'],
 // This field is intentionally optional.  It is the reliable bridge between
 // the physical production floor and SAP when the chassis is released before
 // all 261 postings are entered.  The aliases cover the labels people use in
 // the Google Sheet as well as labels copied from SAP/English exports.
 physical:['Finalizada física','Finalizado físico','Finalização física','Física finalizada','Chassi finalizado','Chassi finalizada','Concluída fisicamente','Concluído fisicamente','Concluída física','Physical complete','Physical completion','Physically complete']
};

export type CooisOrder={
 op:string;
 orderQuantity:number|null;
 supplied:number|null;
 good:number|null;
 statusUser:string;
 statusSystem:string;
 physicalFinalized:boolean;
 physicalField:string;
 completed:boolean;
};

export function cooisAliases(){return aliases;}

/** Values accepted in the optional physical-finalization column. */
export function isPhysicalFinalized(value:unknown):boolean{
 const v=normalize(text(value));
 if(!v||['nao','no','n','false','0','aberta','aberto','pendente','naofinalizada','naofinalizado'].includes(v))return false;
 if(['sim','s','yes','y','true','1','ok','finalizado','finalizada','concluido','concluida','completo','completa','complete','completed','physicalcomplete','physicallycomplete'].includes(v))return true;
 return /(finalizad|conclu|complete|physicalcomplete|physicallycomplete)/.test(v)&&!/(nao|no|pendente|abert)/.test(v);
}

/** Converts the SAP COOIS export into one compact, typed row per order. */
export function convertCoois(rows:Row[]):CooisOrder[]{
 const out:CooisOrder[]=[];
 for(const row of rows){
  const op=text(pick(row,aliases.op));
  if(!op)continue;
  const orderQuantity=number(pick(row,aliases.orderQuantity));
  const supplied=number(pick(row,aliases.supplied));
  const good=number(pick(row,aliases.good));
  const physicalValue=pick(row,aliases.physical);
  const physicalFinalized=isPhysicalFinalized(physicalValue);
  const status=`${text(pick(row,aliases.statusUser))} ${text(pick(row,aliases.statusSystem))}`.toUpperCase();
  // In COOIS, a physically finished chassis can be identified either by the
  // explicit Finalizada física field, by the delivered/confirmed quantity, or
  // by final confirmation statuses. The explicit field is important when the
  // physical chassis was released with one or more material postings still
  // pending in SAP; REL/NOAP alone deliberately does not close an OP.
  const statusCompleted=/\b(?:CONF|FORN|TECO|CLSD|CLOSED|FINAL|ENCERR|ENTREG)\b/.test(status);
  const completed=physicalFinalized||(orderQuantity!==null&&orderQuantity>0&&[supplied,good].some(value=>value!==null&&value>=orderQuantity))||statusCompleted;
  out.push({op,orderQuantity,supplied,good,statusUser:text(pick(row,aliases.statusUser)),statusSystem:text(pick(row,aliases.statusSystem)),physicalFinalized,physicalField:text(physicalValue),completed});
 }
 if(!out.length)throw Error('COOIS sem ordens válidas. Confira a coluna Ordem.');
 return out;
}

export function cooisHeaders(headers:unknown[]):{name:string;index:number}[]{
 const find=(names:string[])=>{
  const index=headers.findIndex(h=>names.some(name=>normalize(name)===normalize(h)));
  return index<0?null:{name:String(headers[index]??''),index};
 };
 const required=[find(aliases.op),find(aliases.orderQuantity),find(aliases.supplied),find(aliases.good)];
 if(required.some(item=>!item))throw Error('A aba COOIS precisa ter Ordem, Quantidade da ordem, Qtd.fornecida e Quantidade boa confirmada.');
 const optional=[find(aliases.statusUser),find(aliases.statusSystem),find(aliases.physical)].filter(Boolean) as {name:string;index:number}[];
 return [...required as {name:string;index:number}[],...optional].filter((item,index,array)=>array.findIndex(x=>x.index===item.index)===index);
}
