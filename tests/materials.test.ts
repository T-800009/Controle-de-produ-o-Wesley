import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateRows} from '../lib/materials.ts';
test('rejects a movement list in place of the BOM',()=>{assert.throws(()=>validateRows([{material:'10004930-00',description:'Material',required:null,unit:'',consumption:{}}],'consumo'),/Base incompatível/)});
test('accepts a BOM with OP headers and partial missing cells',()=>{assert.doesNotThrow(()=>validateRows([{material:'001-A',required:2,unit:'PCS',consumption:{'19000000123':null}}],'consumo'))});
