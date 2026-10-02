import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnaCheck} from '../lib/ana-check.ts';
import {summarizeAnaMoney} from '../lib/ana-cost.ts';
import {anaColumns} from '../lib/ana-columns.ts';

const k=(qty:number,amount:unknown,extra={})=>({Ordem:2315,Material:'PART','Qtd.total entrada':qty,'Valor/MR':amount,'Moeda do relatório':'BRL',...extra});
const z=(qty:number,extra={})=>({Ordem:2315,Material:'PART','BOM QTY':qty,...extra});

test('KOB1 uses net value divided by net quantity and keeps labor costs outside the material reference',()=>{
 const result=buildAnaCheck([k(5,100),k(-2,-40),k(387,33088.50,{Material:'','Unid.medida lançamento':'MIN'})],[z(4)]);
 const row=result.rows[0];
 assert.equal(result.rows.length,1);assert.equal(row.actual,3);assert.equal(row.price,20);assert.equal(row.differenceValue,-20);
 assert.equal(row.priceSource,'KOB1');assert.equal(row.priceEstimated,true);assert.equal(row.priceCurrency,'BRL');
 assert.equal(row.priceAmount,60);assert.equal(row.priceQuantity,3);
});

test('native transaction-currency fields from the screenshot are accepted without MM60',()=>{
 const columns=anaColumns(['Ordem','Material','Qtd.total entrada','Valor/moed.transação','Moeda da transação'],'KOB1');
 assert.equal(columns.find(c=>c.field==='Valor/moed.transação')?.index,3);
 const [row]=buildAnaCheck([{Ordem:2315,Material:'PART','Qtd.total entrada':4,'Valor/moed.transação':'584,37','Moeda da transação':'BRL'}],[z(5)]).rows;
 assert.equal(row.price,584.37/4);assert.equal(row.differenceValue,-146.0925);
 assert.match(row.priceMethod,/Valor\/moed.transação/);
});

test('report and transaction amounts use their own currency and are never summed together',()=>{
 const [row]=buildAnaCheck([k(4,40,{'Moeda do relatório':'USD','Valor/moed.transação':200,'Moeda da transação':'BRL'})],[z(5)]).rows;
 assert.equal(row.price,10);assert.equal(row.priceCurrency,'USD');assert.equal(row.differenceValue,-10);
 const [fallback]=buildAnaCheck([k(4,null,{'Moeda do relatório':'USD','Valor/moed.transação':200,'Moeda da transação':'BRL'})],[z(5)]).rows;
 assert.equal(fallback.price,50);assert.equal(fallback.priceCurrency,'BRL');
});

test('ZPP009 divides Input Cost by actual input, not BOM quantity or planning quantity',()=>{
 const [row]=buildAnaCheck([k(5,null)],[z(6,{'Input Cost':'-512.030,35','Actual input of raw material':-5,'Planning QTY':999,'Planned input of Raw material':999})]).rows;
 assert.ok(Math.abs(row.price!-102406.07)<1e-8);assert.equal(row.difference,-1);assert.equal(row.differenceValue,-102406.07);
 assert.equal(row.priceSource,'ZPP009');assert.equal(row.priceCurrency,null);assert.equal(row.priceEstimated,true);
 assert.equal(row.priceQuantity,-5);
 assert.equal(summarizeAnaMoney([row]).groups.length,0);assert.equal(summarizeAnaMoney([row]).unknownCurrency,1);
});

test('MM60 remains the preferred reference and respects its price unit',()=>{
 const [row]=buildAnaCheck([k(4,80)],[z(5)],[{Material:'PART','Preço':1000,'Unidade preço':100,'Moeda':'BRL'}]).rows;
 assert.equal(row.price,10);assert.equal(row.differenceValue,-10);assert.equal(row.priceEstimated,false);assert.equal(row.priceSource,'MM60');
 const [zero]=buildAnaCheck([k(4,80)],[z(5)],[{Material:'PART','Preço':0,'Moeda':'BRL'}]).rows;
 assert.equal(zero.price,0);assert.equal(zero.differenceValue,0);
});

test('zero net quantities, missing amounts, currency conflicts and inconsistent signs cannot invent a price',()=>{
 const cases=[
  [k(2,20),k(-2,-20)],
  [k(2,20),k(2,null)],
  [k(2,20),k(2,20,{'Moeda do relatório':'USD'})],
  [k(2,20),k(2,20,{'Moeda do relatório':''})],
  [k(-2,20)],
  [k(0,10)],
 ];
 for(const kob of cases){const row=buildAnaCheck(kob,[z(5)]).rows[0];assert.equal(row.price,null);assert.equal(row.differenceValue,null);}
});

test('a valid zero cost is different from an absent cost and references never leak to another OP',()=>{
 const rows=buildAnaCheck([k(2,0)],[z(3),z(3,{Ordem:2316})]).rows;
 const current=rows.find(r=>r.op==='2315')!,other=rows.find(r=>r.op==='2316')!;
 assert.equal(current.price,0);assert.equal(current.differenceValue,0);
 assert.equal(other.price,null);assert.equal(other.differenceValue,null);
});

test('totals separate currencies and explicitly count unavailable and unknown currency values',()=>{
 const summary=summarizeAnaMoney([
  {differenceValue:-10,priceCurrency:'BRL',priceEstimated:true},
  {differenceValue:-5,priceCurrency:'USD',priceEstimated:true},
  {differenceValue:2,priceCurrency:'BRL',priceEstimated:false},
  {differenceValue:100,priceCurrency:null,priceEstimated:true},
  {differenceValue:null,priceCurrency:'BRL',priceEstimated:false}
 ]);
 assert.deepEqual(summary.groups.map(g=>[g.currency,g.value]),[['BRL',-8],['USD',-5]]);
 assert.equal(summary.unknownCurrency,1);assert.equal(summary.unavailable,1);assert.equal(summary.estimated,3);
});

test('financial totals exclude absent whole orders and show debit and credit without hiding their netting',()=>{
 const rows=buildAnaCheck([k(4,40),k(6,60,{Material:'OTHER'})],
  [z(5),z(5,{Material:'OTHER'}),z(100,{Ordem:2316})],
  [{Material:'PART',Preço:10,Moeda:'BRL'},{Material:'OTHER',Preço:10,Moeda:'BRL'}]).rows;
 const summary=summarizeAnaMoney(rows);
 assert.equal(summary.incomplete,1);assert.equal(summary.groups[0].value,0);
 assert.equal(summary.groups[0].below,-10);assert.equal(summary.groups[0].above,10);
 assert.equal(rows.find(row=>row.op==='2316')!.differenceValue,-1000,'Raw Excel value remains auditable, outside trusted totals');
});
