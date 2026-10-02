/**
 * Conferência de assinaturas digitais de PDF (PKCS#7 / CMS destacado, como o
 * Adobe grava: adbe.pkcs7.detached ou ETSI.CAdES.detached).
 *
 * Para cada assinatura:
 *  1. calcula o hash dos trechos do arquivo cobertos pela assinatura (ByteRange)
 *     e compara com o hash gravado dentro dela (messageDigest);
 *  2. confere a assinatura criptográfica com a chave pública do certificado.
 *
 * Só "valid" significa conferida. Qualquer caso que não dê para conferir
 * (algoritmo desconhecido, sem certificado, estrutura estranha) é "unchecked",
 * nunca aceito como assinado.
 *
 * Isso prova que o conteúdo não mudou depois de assinado e mostra de quem é o
 * certificado e quem o emitiu (ex.: byd-PS-CA-01-CA). A cadeia até a
 * certificadora não é conferida aqui (o portal não tem o certificado da CA):
 * isso continua sendo papel do Adobe. Usa só WebCrypto; roda no navegador e no Node.
 */

type Node = { tag: number; start: number; contentStart: number; contentEnd: number; end: number; indefinite: boolean };

function readNode(bytes: Uint8Array, position: number, limit: number, depth = 0): Node {
  if (depth > 64 || position + 2 > limit) throw Error("DER inválido");
  const tag = bytes[position];
  let cursor = position + 1;
  if ((tag & 0x1f) === 0x1f) {
    while (cursor < limit && bytes[cursor] & 0x80) cursor++;
    cursor++;
  }
  if (cursor >= limit) throw Error("DER incompleto");
  let length = bytes[cursor++];
  if (length === 0x80) {
    // BER com comprimento indefinido: vai até o marcador 00 00.
    let inner = cursor;
    for (;;) {
      if (inner + 1 >= limit) throw Error("DER incompleto");
      if (bytes[inner] === 0 && bytes[inner + 1] === 0) return { tag, start: position, contentStart: cursor, contentEnd: inner, end: inner + 2, indefinite: true };
      const next = readNode(bytes, inner, limit, depth + 1).end;
      if (!(next > inner)) throw Error("DER inválido");
      inner = next;
    }
  }
  if (length & 0x80) {
    const size = length & 0x7f;
    if (size < 1 || size > 4 || cursor + size > limit) throw Error("DER inválido");
    length = 0;
    for (let i = 0; i < size; i++) length = length * 256 + bytes[cursor++];
  }
  const end = cursor + length;
  if (!Number.isFinite(end) || end > limit) throw Error("DER incompleto");
  return { tag, start: position, contentStart: cursor, contentEnd: end, end, indefinite: false };
}
function children(bytes: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  for (let cursor = node.contentStart; cursor < node.contentEnd; ) {
    const child = readNode(bytes, cursor, node.contentEnd);
    if (!(child.end > cursor)) throw Error("DER inválido");
    out.push(child);
    cursor = child.end;
  }
  return out;
}
const content = (bytes: Uint8Array, node: Node) => bytes.subarray(node.contentStart, node.contentEnd);
const whole = (bytes: Uint8Array, node: Node) => bytes.subarray(node.start, node.end);
function oid(bytes: Uint8Array, node: Node | undefined) {
  if (!node || node.tag !== 0x06) return "";
  const data = content(bytes, node);
  const parts: number[] = [];
  let value = 0;
  for (const byte of data) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      if (!parts.length) parts.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
      else parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}
function integer(bytes: Uint8Array, node: Node | undefined) {
  if (!node || node.tag !== 0x02) return null;
  let value = 0;
  for (const byte of content(bytes, node)) value = value * 256 + byte;
  return value;
}
function decodeString(bytes: Uint8Array, node: Node) {
  const data = content(bytes, node);
  if (node.tag === 0x0c) return new TextDecoder("utf-8").decode(data);
  if (node.tag === 0x1e) {
    let out = "";
    for (let i = 0; i + 1 < data.length; i += 2) out += String.fromCharCode((data[i] << 8) | data[i + 1]);
    return out;
  }
  return Array.from(data, (byte) => String.fromCharCode(byte)).join("");
}
function decodeTime(bytes: Uint8Array, node: Node): string | null {
  const raw = decodeString(bytes, node);
  const match = node.tag === 0x17 ? raw.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/) : raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);
  if (!match) return null;
  const year = node.tag === 0x17 ? (Number(match[1]) >= 50 ? 1900 : 2000) + Number(match[1]) : Number(match[1]);
  const date = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function commonName(bytes: Uint8Array, name: Node | undefined) {
  if (!name) return "";
  for (const set of children(bytes, name))
    for (const pair of children(bytes, set)) {
      const [type, value] = children(bytes, pair);
      if (type && value && oid(bytes, type) === "2.5.4.3") return decodeString(bytes, value);
    }
  return "";
}
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

const HASHES: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};
const RSA_WITH: Record<string, string> = {
  "1.2.840.113549.1.1.5": "SHA-1",
  "1.2.840.113549.1.1.11": "SHA-256",
  "1.2.840.113549.1.1.12": "SHA-384",
  "1.2.840.113549.1.1.13": "SHA-512",
};
const ECDSA_WITH: Record<string, string> = {
  "1.2.840.10045.4.1": "SHA-1",
  "1.2.840.10045.4.3.2": "SHA-256",
  "1.2.840.10045.4.3.3": "SHA-384",
  "1.2.840.10045.4.3.4": "SHA-512",
};
const CURVES: Record<string, [string, number]> = {
  "1.2.840.10045.3.1.7": ["P-256", 32],
  "1.3.132.0.34": ["P-384", 48],
  "1.3.132.0.35": ["P-521", 66],
};
const RSA_PSS = "1.2.840.113549.1.1.10";

const subtle = () => globalThis.crypto.subtle;
const buffer = (data: Uint8Array) => data.slice().buffer as ArrayBuffer;
export async function sha256Hex(data: Uint8Array) {
  const digest = new Uint8Array(await subtle().digest("SHA-256", buffer(data)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ECDSA em DER (SEQUENCE r,s) → r||s de tamanho fixo, como o WebCrypto espera. */
function ecdsaRaw(bytes: Uint8Array, size: number) {
  const sequence = readNode(bytes, 0, bytes.length);
  const out = new Uint8Array(size * 2);
  const parts = children(bytes, sequence);
  if (parts.length !== 2) throw Error("ECDSA inválido");
  parts.forEach((part, index) => {
    let value = content(bytes, part);
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw Error("ECDSA inválido");
    out.set(value, index * size + (size - value.length));
  });
  return out;
}

/** RSASSA-PSS-params: hash ([0]) e tamanho do sal ([2]); padrões SHA-1 / 20. */
function pssParams(bytes: Uint8Array, parameters: Node | undefined) {
  let hash = "SHA-1",
    salt = 20;
  if (parameters && parameters.tag === 0x30)
    for (const field of children(bytes, parameters)) {
      const [inner] = children(bytes, field);
      if (field.tag === 0xa0 && inner) hash = HASHES[oid(bytes, children(bytes, inner)[0])] || "";
      if (field.tag === 0xa2) salt = integer(bytes, inner) ?? -1;
    }
  return hash && salt >= 0 ? { hash, salt } : null;
}

type Certificate = { spki: Node; serial: Node; issuer: Node; subject: Node; ski: Uint8Array | null; subjectName: string; issuerName: string; selfSigned: boolean };
function readCertificates(bytes: Uint8Array, set: Node | undefined): Certificate[] {
  if (!set) return [];
  const out: Certificate[] = [];
  for (const cert of children(bytes, set)) {
    if (cert.tag !== 0x30) continue;
    const tbs = children(bytes, children(bytes, cert)[0]);
    const offset = tbs[0]?.tag === 0xa0 ? 1 : 0;
    const serial = tbs[offset],
      issuer = tbs[offset + 2],
      subject = tbs[offset + 4],
      spki = tbs[offset + 5];
    if (!serial || !issuer || !subject || !spki) continue;
    let ski: Uint8Array | null = null;
    const extensions = tbs.find((node) => node.tag === 0xa3);
    if (extensions)
      for (const extension of children(bytes, children(bytes, extensions)[0])) {
        const parts = children(bytes, extension);
        if (oid(bytes, parts[0]) === "2.5.29.14") {
          const wrapped = content(bytes, parts[parts.length - 1]);
          try {
            ski = content(wrapped, readNode(wrapped, 0, wrapped.length));
          } catch {
            ski = null;
          }
        }
      }
    out.push({ spki, serial, issuer, subject, ski, subjectName: commonName(bytes, subject), issuerName: commonName(bytes, issuer), selfSigned: equalBytes(whole(bytes, issuer), whole(bytes, subject)) });
  }
  return out;
}

async function verifyWith(bytes: Uint8Array, certificate: Certificate, algorithm: Node, digestName: string, signature: Uint8Array, signed: Uint8Array): Promise<boolean | null> {
  const [algorithmId] = children(bytes, certificate.spki);
  const [keyType, keyParameters] = children(bytes, algorithmId);
  const keyOid = oid(bytes, keyType);
  const [algorithmOid, algorithmParameters] = children(bytes, algorithm);
  const signatureOid = oid(bytes, algorithmOid);
  const spki = buffer(whole(bytes, certificate.spki));
  try {
    if (keyOid === "1.2.840.113549.1.1.1" || keyOid === RSA_PSS) {
      if (signatureOid === RSA_PSS) {
        const params = pssParams(bytes, algorithmParameters);
        if (!params) return null;
        const key = await subtle().importKey("spki", spki, { name: "RSA-PSS", hash: params.hash }, false, ["verify"]);
        return await subtle().verify({ name: "RSA-PSS", saltLength: params.salt }, key, buffer(signature), buffer(signed));
      }
      const hash = signatureOid === "1.2.840.113549.1.1.1" ? digestName : RSA_WITH[signatureOid];
      if (!hash || keyOid !== "1.2.840.113549.1.1.1") return null;
      const key = await subtle().importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
      return await subtle().verify("RSASSA-PKCS1-v1_5", key, buffer(signature), buffer(signed));
    }
    if (keyOid === "1.2.840.10045.2.1" && keyParameters) {
      const curve = CURVES[oid(bytes, keyParameters)];
      const hash = ECDSA_WITH[signatureOid] || (signatureOid === "1.2.840.10045.2.1" ? digestName : "");
      if (!curve || !hash) return null;
      const key = await subtle().importKey("spki", spki, { name: "ECDSA", namedCurve: curve[0] }, false, ["verify"]);
      let raw: Uint8Array;
      try {
        raw = ecdsaRaw(signature, curve[1]);
      } catch {
        return false;
      }
      return await subtle().verify({ name: "ECDSA", hash }, key, buffer(raw), buffer(signed));
    }
  } catch {
    return null;
  }
  return null;
}

export type CmsCheck = {
  check: "valid" | "invalid" | "unchecked";
  /** Nome comum (CN) do certificado de quem assinou. */
  signer: string;
  issuer: string;
  selfSigned: boolean;
  signingTime: string | null;
  detail: string;
};

/**
 * cms: bytes de /Contents (os zeros de preenchimento no fim são ignorados, o
 * DER informa o próprio tamanho). signedData: os trechos do ByteRange, juntos.
 */
export async function checkCmsSignature(cms: Uint8Array, signedData: Uint8Array): Promise<CmsCheck> {
  const result: CmsCheck = { check: "unchecked", signer: "", issuer: "", selfSigned: false, signingTime: null, detail: "" };
  const unchecked = (detail: string): CmsCheck => ({ ...result, check: "unchecked", detail });
  try {
    const info = readNode(cms, 0, cms.length);
    const [contentType, explicit] = children(cms, info);
    if (oid(cms, contentType) !== "1.2.840.113549.1.7.2" || !explicit) return unchecked("Formato de assinatura não reconhecido.");
    const signedDataNode = children(cms, explicit)[0];
    const parts = children(cms, signedDataNode);
    const certificates = readCertificates(cms, parts.find((node) => node.tag === 0xa0));
    const signerInfos = parts[parts.length - 1];
    const signerInfo = signerInfos?.tag === 0x31 ? children(cms, signerInfos)[0] : undefined;
    if (!signerInfo) return unchecked("Assinatura sem dados do signatário.");
    const fields = children(cms, signerInfo);
    let index = 1;
    const sid = fields[index++];
    const digestAlgorithm = oid(cms, children(cms, fields[index++])[0]);
    const signedAttributes = fields[index]?.tag === 0xa0 ? fields[index++] : null;
    const signatureAlgorithm = fields[index++];
    const signatureNode = fields[index++];
    if (!sid || !signatureAlgorithm || !signatureNode || signatureNode.tag !== 0x04) return unchecked("Assinatura incompleta.");
    const signatureValue = content(cms, signatureNode);
    const digestName = HASHES[digestAlgorithm] || "";

    // Certificado do signatário: emissor+série ou identificador de chave (SKI).
    let candidates: Certificate[] = [];
    if (sid.tag === 0x30) {
      const [issuer, serial] = children(cms, sid);
      candidates = certificates.filter((cert) => serial && issuer && equalBytes(content(cms, serial), content(cms, cert.serial)) && equalBytes(whole(cms, issuer), whole(cms, cert.issuer)));
    } else if (sid.tag === 0x80) {
      const keyId = content(cms, sid);
      candidates = certificates.filter((cert) => cert.ski && equalBytes(cert.ski, keyId));
    }
    // Sem correspondência explícita: testa cada certificado embutido.
    const exact = candidates.length > 0;
    if (!exact) candidates = certificates;
    const describe = (cert: Certificate | undefined) => {
      result.signer = cert?.subjectName || "";
      result.issuer = cert?.issuerName || "";
      result.selfSigned = !!cert?.selfSigned;
    };
    describe(candidates[0]);
    if (!digestName) return unchecked("Algoritmo de resumo não suportado.");

    const actual = new Uint8Array(await subtle().digest(digestName, buffer(signedData)));
    let signedBytes = signedData;
    if (signedAttributes) {
      let messageDigest: Uint8Array | null = null;
      for (const attribute of children(cms, signedAttributes)) {
        const [type, values] = children(cms, attribute);
        const id = oid(cms, type);
        const value = values ? children(cms, values)[0] : null;
        if (!value) continue;
        if (id === "1.2.840.113549.1.9.4" && value.tag === 0x04) messageDigest = content(cms, value);
        if (id === "1.2.840.113549.1.9.5" && (value.tag === 0x17 || value.tag === 0x18)) result.signingTime = decodeTime(cms, value);
      }
      if (!messageDigest) return unchecked("A assinatura não traz o resumo do documento.");
      if (!equalBytes(messageDigest, actual)) return { ...result, check: "invalid", detail: "O conteúdo do PDF mudou depois desta assinatura." };
      if (signedAttributes.indefinite) return unchecked("Estrutura da assinatura fora do padrão: confira no Adobe.");
      // Os atributos assinados são conferidos como SET (tag 0x31), não como [0].
      signedBytes = whole(cms, signedAttributes).slice();
      signedBytes[0] = 0x31;
    }
    if (!certificates.length) return unchecked("A assinatura não traz o certificado de quem assinou.");
    let refused = false;
    for (const cert of candidates) {
      const verified = await verifyWith(cms, cert, signatureAlgorithm, digestName, signatureValue, signedBytes);
      if (verified === true) {
        describe(cert);
        const by = cert.selfSigned ? " ID digital próprio (autoassinado), não emitido por uma certificadora." : cert.issuerName ? ` Certificado emitido por ${cert.issuerName}.` : "";
        return { ...result, check: "valid", detail: "Assinatura válida: o conteúdo não mudou depois de assinado." + by };
      }
      if (verified === false) refused = true;
    }
    if (refused) return { ...result, check: "invalid", detail: "A assinatura criptográfica não confere com o certificado." };
    return unchecked("Tipo de chave ou algoritmo não suportado na conferência: confira no Adobe.");
  } catch {
    return unchecked("Não foi possível ler esta assinatura.");
  }
}
