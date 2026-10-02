import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnaCheck} from '../lib/ana-check.ts';
import {anaOrderOverview} from '../lib/ana-overview.ts';
import {materialDescription} from '../lib/material-description.ts';

test('COOIS confirmation highlights a real shortage without changing consumption or existing closure context',()=>{
 const kob=[{Ordem:1,Material:'A','Qtd.total entrada':1},{Ordem:2,Material:'A','Qtd.total entrada':1},{Ordem:3,Material:'A','Qtd.total entrada':2},{Ordem:4,Material:'A','Qtd.total entrada':1},{Ordem:5,Material:'A','Qtd.total entrada':1}];
 const zpp=[1,2,3,4,5,6].map(op=>({Ordem:op,Material:'A','BOM QTY':2}));
 const coois=[{Ordem:1,'Status do sistema':'REL CONF FORN','Quantidade boa confirmada':null},{Ordem:2,'Status do sistema':'REL TECO FORN'},{Ordem:3,'Status do sistema':'REL CNF'},{Ordem:4,'Status do sistema':'REL PCNF'},{Ordem:5,'Quantidade boa confirmada':1},{Ordem:6,'Status do sistema':'CNF'}];
 const withCoois=buildAnaCheck(kob,zpp,[],coois),without=buildAnaCheck(kob,zpp);
 assert.deepEqual(withCoois.rows.map(r=>[r.op,r.difference,r.status]),without.rows.map(r=>[r.op,r.difference,r.status]));
 const flags=new Map(anaOrderOverview(withCoois.rows).map(op=>[op.op,op.flag]));
 assert.equal(flags.get('1'),'posted_pending');assert.equal(flags.get('2'),'pending');assert.equal(flags.get('3'),'balanced');assert.equal(flags.get('4'),'posted_pending');assert.equal(flags.get('5'),'posted_pending');assert.equal(flags.get('6'),'incomplete');
 assert.equal(withCoois.rows.find(r=>r.op==='2')!.completed,true,'Legacy context remains but is not proof of confirmation');
});
test('an order with invalid quantities or excess is never shown as all balanced',()=>{
 const check=buildAnaCheck([{Ordem:1,Material:'A','Qtd.total entrada':'???'},{Ordem:2,Material:'A','Qtd.total entrada':3}], [{Ordem:1,Material:'A','BOM QTY':2},{Ordem:2,Material:'A','BOM QTY':2}],[],[{Ordem:1,'Status do sistema':'CONF'}]);
 const flags=new Map(anaOrderOverview(check.rows).map(op=>[op.op,op.flag]));assert.equal(flags.get('1'),'review');assert.equal(flags.get('2'),'excess');
});
test('display translations preserve original data and use current Portuguese MM60 over bundled descriptions',()=>{
 const raw='BMK9NA-3509030_空压机出气口消声器_M00666';
 const translated=materialDescription('12943277-00',raw);
 assert.match(translated.text,/Silenciador/);assert.equal(translated.original,raw);assert.equal(translated.translated,true);assert.equal(translated.untranslated,false);
 assert.equal(materialDescription('12943277-00',raw,'Descrição nova SAP').text,'Descrição nova SAP');
 assert.equal(materialDescription('12943277-00','Nome português atualizado').text,'Nome português atualizado');
 const unknown=materialDescription('99999-00','未知材料');assert.equal(unknown.text,'未知材料');assert.equal(unknown.untranslated,true);
 const result=buildAnaCheck([{Ordem:1,Material:'12943277-00','Qtd.total entrada':1}], [{Ordem:1,Material:'12943277-00',Description:raw,'BOM QTY':2}]);
 assert.equal(result.rows[0].description,raw);assert.match(result.rows[0].displayDescription.text,/Silenciador/);assert.equal(result.rows[0].difference,-1);
});
