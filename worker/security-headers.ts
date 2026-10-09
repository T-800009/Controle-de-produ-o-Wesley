// Somente cabeçalhos: o módulo principal do Worker não pode exportar nada além do handler.
/** Cabeçalhos de segurança em todas as respostas (páginas, APIs, PDFs e erros). */
export const PORTAL_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; worker-src 'self' blob:; object-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function secured(response:Response){
 const headers=new Headers(response.headers);
 headers.set('X-Content-Type-Options','nosniff');
 if(!headers.has('X-Frame-Options'))headers.set('X-Frame-Options','DENY');
 headers.set('Referrer-Policy','same-origin');
 headers.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
 headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()');
 headers.set('Cross-Origin-Opener-Policy','same-origin');
 headers.set('Cross-Origin-Resource-Policy','same-origin');
 headers.set('X-Robots-Tag','noindex, nofollow');
 if(headers.get('Content-Type')?.includes('text/html')&&!headers.has('Content-Security-Policy'))headers.set('Content-Security-Policy',PORTAL_CSP);
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
