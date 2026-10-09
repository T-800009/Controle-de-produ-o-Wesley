/**
 * Versão do portal: a mesma no Worker (/api/version) e na tela. Uma aba aberta
 * antes de uma atualização continua com o código antigo até recarregar; a tela
 * compara as duas para avisar (e para nunca gerar PDF com o código antigo).
 */
export const PORTAL_VERSION = "MB51-73";
