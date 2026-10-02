import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnaCheck} from '../lib/ana-check.ts';

test('consolida KOB1 e ZPP009 por Ordem + Material e calcula a diferença financeira',()=>{
 const result=buildAnaCheck(
  [{Ordem:'19000000001',Material:'100-00','Qtd.total entrada':3,'Texto breve material':'Parafuso'},
   {Ordem:'19000000001',Material:'100-00','Qtd.total entrada':2,'Texto breve material':'Parafuso'},
   {Ordem:'19000000001',Material:'200-00','Qtd.total entrada':4,'Texto breve material':'Porca'}],
  [{Ordem:'19000000001',Material:'100-00','BOM QTY':5,Description:'Parafuso'},
   {Ordem:'19000000001',Material:'200-00','BOM QTY':2,Description:'Porca'},
   {Ordem:'19000000001',Material:'300-00','BOM QTY':1,Description:'Arruela'}],
  [{Material:'100-00','Preço':10},{Material:'200-00','Preço':2},{Material:'300-00','Preço':1}],
  [{Ordem:'19000000001','Quantidade da ordem':1,'Qtd.fornecida':1,'Quantidade boa confirmada':1,'Status do sistema':'TECO'}]
 );
 assert.equal(result.rows.length,3);
 const exact=result.rows.find(row=>row.material==='100-00')!;
 assert.equal(exact.actual,5);assert.equal(exact.bom,5);assert.equal(exact.difference,0);assert.equal(exact.status,'complete');
 const excess=result.rows.find(row=>row.material==='200-00')!;
 assert.equal(excess.difference,2);assert.equal(excess.differenceValue,4);assert.equal(excess.status,'excess');
 const missing=result.rows.find(row=>row.material==='300-00')!;
 assert.equal(missing.actual,null);assert.equal(missing.difference,-1);assert.equal(missing.status,'shortage');
 assert.equal(exact.completed,true);assert.equal(result.orders[0],'19000000001');
});

import {summarizeAnaAudit} from '../lib/ana-audit.ts';
test('audit separates unique codes, OP/material pairs, incomplete data and data errors',()=>{
 const kob=[{Ordem:1,Material:'A','Qtd.total entrada':1},{Ordem:2,Material:'A','Qtd.total entrada':1},{Ordem:2,Material:'B','Qtd.total entrada':null}];
 const zpp=[{Ordem:1,Material:'A','BOM QTY':2},{Ordem:2,Material:'A','BOM QTY':2},{Ordem:2,Material:'B','BOM QTY':2},{Ordem:3,Material:'A','BOM QTY':100}];
 const summary=summarizeAnaAudit(buildAnaCheck(kob,zpp).rows);
 assert.equal(summary.divergentPairs,2);assert.equal(summary.divergentMaterials,1);
 assert.equal(summary.incomplete,1);assert.equal(summary.review,1);assert.equal(summary.orders,3);
});
