import test from 'node:test';
import assert from 'node:assert/strict';
import {addFixedBomItems,FIXED_BOM_ITEMS} from '../lib/bom-additions.ts';

test('adds Tirreno once with 15 KG for every OP',()=>{
 const rows=addFixedBomItems([{material:'001-A',unit:'PCS'}],['19000000001','19000000002']);
 const item=rows.find(row=>row.material===FIXED_BOM_ITEMS[0].material);
 assert.equal(item?.required,15);
 assert.equal(item?.unit,'KG');
 assert.equal(item?.classification,'C');
 assert.deepEqual(item?.consumption,{19000000001:null,19000000002:null});
});

test('does not duplicate Tirreno when BOM already contains it',()=>{
 const rows=addFixedBomItems([{material:'11242550-00',unit:'KG',required:15}],['19000000001']);
 assert.equal(rows.filter(row=>row.material==='11242550-00').length,1);
});
