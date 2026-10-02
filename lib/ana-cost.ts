/** Cost references do not change the quantity reconciliation.
 * Derived values are estimates at the observed OP/material cost, not MM60 prices.
 */
export type PriceSource='MM60'|'KOB1'|'ZPP009';
export type PriceReference={price:number;currency:string|null;source:PriceSource;estimated:boolean;method:string;amount:number;quantity:number};
export type CostLedger={quantity:number;amount:number;lines:number;currencies:Set<string>;unknownCurrency:boolean;invalid:boolean};
export const costLedger=():CostLedger=>({quantity:0,amount:0,lines:0,currencies:new Set(),unknownCurrency:false,invalid:false});
export function currencyCode(value:unknown):string|null{
 const code=String(value??'').trim().toUpperCase();
 if(code==='R$')return 'BRL';
 return /^[A-Z]{3}$/.test(code)?code:null;
}
export function addCost(ledger:CostLedger,quantity:number|null,amount:number|null,currency:unknown){
 ledger.lines++;
 const code=currencyCode(currency);if(code)ledger.currencies.add(code);else ledger.unknownCurrency=true;
 if(quantity===null||amount===null||!Number.isFinite(quantity)||!Number.isFinite(amount)){
  ledger.invalid=true;return;
 }
 // Do not hide a reversal by applying abs() to each posting. A cost-only
 // adjustment or opposite signs cannot establish a reliable unit reference.
 if((quantity===0&&amount!==0)||(quantity*amount<0))ledger.invalid=true;
 ledger.quantity+=quantity;ledger.amount+=amount;
}
export function costReference(ledger:CostLedger,source:'KOB1'|'ZPP009',method:string):PriceReference|null{
 if(!ledger.lines||ledger.invalid||Math.abs(ledger.quantity)<1e-9||ledger.currencies.size>1||(ledger.currencies.size&&ledger.unknownCurrency))return null;
 let price=ledger.amount/ledger.quantity;
 if(!Number.isFinite(price)||price<0)return null;
 if(Object.is(price,-0))price=0;
 return {price,currency:ledger.currencies.values().next().value??null,source,estimated:true,method,amount:ledger.amount,quantity:ledger.quantity};
}

export type FinancialRow={differenceValue:number|null;priceCurrency:string|null;priceEstimated:boolean;coverage?:string};
export function summarizeAnaMoney(rows:FinancialRow[]){
 const groups=new Map<string,{currency:string;value:number;below:number;above:number;lines:number;estimated:number}>();
 let unavailable=0,unknownCurrency=0,estimated=0,incomplete=0;
 for(const row of rows){
  if(row.coverage&&row.coverage!=='both'){incomplete++;continue;}
  if(row.differenceValue===null){unavailable++;continue;}
  if(row.priceEstimated)estimated++;
  // Never label an unknown source currency BRL, or add it to a BRL subtotal.
  if(!row.priceCurrency){unknownCurrency++;continue;}
  const group=groups.get(row.priceCurrency)||{currency:row.priceCurrency,value:0,below:0,above:0,lines:0,estimated:0};
  group.value+=row.differenceValue;group.lines++;if(row.priceEstimated)group.estimated++;
  if(row.differenceValue<0)group.below+=row.differenceValue;else group.above+=row.differenceValue;
  groups.set(row.priceCurrency,group);
 }
 return {groups:[...groups.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),unavailable,unknownCurrency,estimated,incomplete};
}
