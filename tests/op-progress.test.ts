import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOpProgress,progressLabel,shortOpLabels} from '../lib/op-progress.ts';
import {shortageReport} from '../lib/shortages.ts';
const bom={id:'test',name:'BOM',revision:'',source:'test',ops:['OP1','OP2'],rows:[
 {material:'A-1',unit:'PCS',classification:'A',required:2,consumption:{OP1:2,OP2:1}},
 {material:'A-2',unit:'KG',classification:'A',required:100,consumption:{OP1:0,OP2:100}},
 {material:'B-1',unit:'PCS',classification:'B',required:1,consumption:{OP1:1,OP2:1}},
 {material:'C-1',unit:'KG',classification:'C',required:15,consumption:{OP1:15,OP2:15}}
]};

test('class percentages count consolidated materials without mixing quantities or units',()=>{
 const report=shortageReport(bom,null,null),summary=summarizeOpProgress(report.allRows,bom.ops);
 assert.deepEqual(summary.map(item=>item.classes.A.percent),[50,50]);
 assert.equal(summary[0].classes.B.percent,100);assert.equal(summary[0].classes.C.percent,100);
 assert.equal(summary[0].complete,false);
});
test('SCRAP is reflected once and repeated BOM rows are not extra chart items',()=>{
 const source={...bom,ops:['OP2'],rows:[bom.rows[0],{...bom.rows[0],required:0}],scrap:[{Material:'A-1',OP:'OP2',Quantidade:1}]};
 const report=shortageReport(source,null,null);
 const result=summarizeOpProgress(report.allRows,source.ops)[0];
 assert.equal(result.classes.A.total,1);assert.equal(result.classes.A.percent,100);assert.equal(result.classes.B.percent,null);
});
test('COOIS closure, abundant stock and manual markings never inflate SAP completion',()=>{
 const source={...bom,ops:['OP2'],coois:[{op:'OP2',completed:true,physicalFinalized:true}]};
 const report=shortageReport(source,null,null);
 assert.equal(report.sapPending.length,0);assert.equal(report.rows.length,1);
 const result=summarizeOpProgress(report.allRows.map(row=>({...row,manual:true,available:1e6,covered:1e6})),source.ops)[0];
 assert.equal(result.classes.A.percent,50);assert.equal(result.pending,1);assert.equal(result.complete,false);
 const missingCoois=shortageReport({...source,coois:[{op:'OP-OTHER',completed:true}]},null,null);
 assert.equal(summarizeOpProgress(missingCoois.allRows,source.ops)[0].classes.A.percent,50,'COOIS metadata must not erase known SAP consumption');
});
test('unknown values, missing classes and empty OPs never become 100%',()=>{
 const source={...bom,rows:[{...bom.rows[0],consumption:{OP1:null,OP2:2}},{...bom.rows[1],classification:'',consumption:{OP1:100,OP2:100}}]};
 const report=shortageReport(source,null,null),summary=summarizeOpProgress(report.allRows,[...source.ops,'OP3']);
 assert.equal(summary[0].classes.A.review,1);assert.equal(summary[0].classes.A.percent,null);assert.equal(progressLabel(summary[0].classes.A),'—');assert.equal(summary[0].unclassified,1);
 assert.equal(summary[1].complete,false);assert.equal(summary[2].complete,false);assert.equal(summary[2].classes.A.percent,null);
 assert.equal(progressLabel(summary[2].classes.A),'—');
});
test('100% is displayed only when every item is attended, not after rounding',()=>{
 assert.equal(progressLabel({total:10000,done:9999,pending:1,review:0,percent:99.99}),'99,9%');
 assert.equal(progressLabel({total:50,done:29,pending:21,review:0,percent:29/50*100}),'58%');
 const labels=shortOpLabels(['19000012315','19000022315']);assert.notEqual(labels.get('19000012315'),labels.get('19000022315'));
});
