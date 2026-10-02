import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cooisHeaders,convertCoois,isPhysicalFinalized} from '../lib/coois.ts';

test('physical finalization column closes an OP with pending SAP postings',()=>{
 const [row]=convertCoois([{Ordem:'19000002671','Quantidade da ordem':1,'Qtd.fornecida':0,'Quantidade boa confirmada':0,'Status do usuário':'REL','Status do sistema':'NOAP','Finalizada física':'SIM'}]);
 assert.equal(row.completed,true);
 assert.equal(row.physicalFinalized,true);
 assert.equal(row.physicalField,'SIM');
});

test('REL/NOAP alone does not pretend that an OP is physically complete',()=>{
 const [row]=convertCoois([{Ordem:'19000002671','Quantidade da ordem':1,'Qtd.fornecida':0,'Quantidade boa confirmada':0,'Status do usuário':'REL','Status do sistema':'NOAP'}]);
 assert.equal(row.completed,false);
 assert.equal(row.physicalFinalized,false);
});

test('physical finalization header is optional and values are strict',()=>{
 const headers=cooisHeaders(['Ordem','Quantidade da ordem','Qtd.fornecida','Quantidade boa confirmada','Finalizada física']);
 assert.equal(headers.some(column=>column.name==='Finalizada física'),true);
 assert.equal(isPhysicalFinalized('NÃO'),false);
 assert.equal(isPhysicalFinalized('SIM'),true);
 assert.equal(isPhysicalFinalized('finalizada fisicamente'),true);
});
