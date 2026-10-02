import {readAutomatic,readConsumptionMany,clearAutomaticCache} from './automatic-client';
self.onmessage=async(event:MessageEvent)=>{
 const {id,base,bases,clear}=event.data;
 if(clear){clearAutomaticCache();return;}
 try{self.postMessage({id,data:bases?await readConsumptionMany(bases):await readAutomatic(base)});}
 catch(error){self.postMessage({id,error:(error as Error).message});}
};
