import {useEffect,useRef,useState,type ReactNode} from 'react';

/** A bounded table with a second, synchronized horizontal scrollbar above it. */
export default function TableViewport({children,className='',label='Tabela de materiais'}:{children:ReactNode;className?:string;label?:string}){
 const body=useRef<HTMLDivElement>(null),top=useRef<HTMLDivElement>(null);
 const [size,setSize]=useState({width:0,overflow:false});
 useEffect(()=>{
  const element=body.current;
  if(!element)return;
  const measure=()=>{
   const width=element.scrollWidth,overflow=width>element.clientWidth+1;
   setSize(previous=>previous.width===width&&previous.overflow===overflow?previous:{width,overflow});
   if(top.current)top.current.scrollLeft=element.scrollLeft;
  };
  measure();
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
  observer?.observe(element);
  const table=element.querySelector('table');
  if(table)observer?.observe(table);
  window.addEventListener('resize',measure);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
 },[children]);
 function sync(source:'top'|'body'){
  const from=source==='top'?top.current:body.current,to=source==='top'?body.current:top.current;
  if(from&&to&&Math.abs(to.scrollLeft-from.scrollLeft)>1)to.scrollLeft=from.scrollLeft;
 }
 return <div className={`table-viewport ${className}`} data-slot="table-container">
  <div className="table-scroll-controls" hidden={!size.overflow}>
   <span>Deslize para ver as outras colunas</span>
   <div ref={top} className="table-scroll-top" role="region" tabIndex={0} aria-label={`Rolagem horizontal: ${label}`} onScroll={()=>sync('top')}><div style={{width:size.width,height:1}}/></div>
  </div>
  <div ref={body} className="table-scroll-body" role="region" tabIndex={0} aria-label={label} onScroll={()=>sync('body')}>{children}</div>
 </div>;
}
