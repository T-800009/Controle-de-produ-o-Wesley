export type StockModule = {
 id: string;
 name: string;
 tabLabel: string;
 sheet: string;
 depot: string | null;
 section: string;
};

/** Shared navigation and source registry for the stock depots. */
export const STOCK_MODULES: readonly StockModule[] = [
 {id:'7000',name:'Depósito 7000',tabLabel:'7000',sheet:'7000',depot:'7000',section:'02 / ESTOQUE'},
 {id:'2000',name:'Depósito 2000',tabLabel:'2000',sheet:'2000',depot:'2000',section:'03 / ESTOQUE'},
 {id:'1500',name:'Depósito 1500',tabLabel:'1500',sheet:'1500',depot:'1500',section:'04 / ESTOQUE'},
];

export function stockModule(id:unknown):StockModule|undefined {
 return STOCK_MODULES.find(module=>module.id===id);
}
