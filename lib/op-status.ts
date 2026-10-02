export const OP_STATUSES=['not_started','waiting','complete'] as const;
export type OpStatus=typeof OP_STATUSES[number];
export type OpStatuses=Record<string,{status:OpStatus;updatedAt:string}>;
export const OP_STATUS_LABELS:Record<OpStatus,string>={
 not_started:'Não iniciada',waiting:'Aguardando Warehouse',complete:'Concluída'
};
export function isOpStatus(value:unknown):value is OpStatus{return OP_STATUSES.includes(value as OpStatus);}
