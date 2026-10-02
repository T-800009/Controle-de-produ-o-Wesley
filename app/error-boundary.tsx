import {Component,type ErrorInfo,type ReactNode} from 'react';

export default class ErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error,info:ErrorInfo){
  console.error('Falha ao exibir o portal',error,info.componentStack);
 }
 render(){
  if(!this.state.failed)return this.props.children;
  return <main className="app-recovery" role="alert">
   <section className="panel">
    <p className="eyebrow">CONTROLE DE PRODUÇÃO · MB51-39</p>
    <h1>Não foi possível exibir esta tela</h1>
    <p>Ocorreu um erro na interface. Recarregue para tentar novamente. Se continuar, envie um print desta mensagem.</p>
    <button className="primary" onClick={()=>window.location.reload()}>Recarregar site</button>
    <a href="/?modulo=consumo">Voltar para BOM × OP</a>
   </section>
  </main>;
 }
}
