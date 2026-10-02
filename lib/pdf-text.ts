/**
 * Texto de uma página de PDF com posição e largura de cada trecho.
 *
 * Usado só para ler os formulários antigos (Excel → PDF) na importação:
 * cada célula do Excel vira um trecho (Tj/TJ) com o ponto inicial e a largura,
 * o suficiente para saber em que coluna e em que linha ele está.
 * Cobre o que esses PDFs usam: fontes Type0 Identity-H e TrueType com
 * ToUnicode, WinAnsi, matrizes (cm/Tm/Td), q/Q e Form XObjects.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

export type TextRun = {
  text: string;
  /** Ponto inicial (linha de base), em pontos da página. */
  x: number;
  y: number;
  width: number;
  /** Altura aproximada da letra. */
  size: number;
  /** Texto girado (cabeçalho vertical): fica fora da leitura das colunas. */
  rotated: boolean;
};
/** box: área da página (MediaBox) em coordenadas do PDF, as mesmas dos trechos e dos campos de assinatura. */
export type PageText = { width: number; height: number; box: { x: number; y: number; width: number; height: number }; runs: TextRun[] };

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* ------------------------------------------------------------------------ */
/* Leitura do conteúdo da página                                             */
/* ------------------------------------------------------------------------ */

type Name = { name: string };
type Value = number | Uint8Array | Name | Value[] | Map<string, Value> | boolean | null | { op: string };
const isName = (value: unknown): value is Name => !!value && typeof value === "object" && "name" in (value as object);
const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

class Lexer {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  skipSpace() {
    const b = this.bytes;
    while (this.pos < b.length) {
      if (WHITE.has(b[this.pos])) this.pos++;
      else if (b[this.pos] === 37) while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      else break;
    }
  }
  /** Próximo valor ou operador; undefined no fim. */
  next(): Value | undefined {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos];
    if (c === 40) return this.literal();
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return this.dict();
      }
      return this.hex();
    }
    if (c === 91) {
      this.pos++;
      const items: Value[] = [];
      for (let guard = 0; guard < 100_000; guard++) {
        this.skipSpace();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 93) {
          this.pos++;
          break;
        }
        const item = this.next();
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (c === 47) {
      this.pos++;
      return { name: this.word() };
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      this.pos++;
      return { op: String.fromCharCode(c) };
    }
    const word = this.word();
    if (!word) {
      this.pos++;
      return { op: "" };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }
  word() {
    const start = this.pos;
    while (this.pos < this.bytes.length && !WHITE.has(this.bytes[this.pos]) && !DELIMITER.has(this.bytes[this.pos])) this.pos++;
    return String.fromCharCode(...this.bytes.subarray(start, this.pos));
  }
  literal() {
    const b = this.bytes,
      out: number[] = [];
    let depth = 0;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) {
        const n = b[this.pos++];
        if (n === 110) out.push(10);
        else if (n === 114) out.push(13);
        else if (n === 116) out.push(9);
        else if (n === 98) out.push(8);
        else if (n === 102) out.push(12);
        else if (n === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (n === 10) {
          // Continuação de linha.
        } else if (n >= 48 && n <= 55) {
          let value = n - 48;
          for (let i = 0; i < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; i++) value = value * 8 + (b[this.pos++] - 48);
          out.push(value & 255);
        } else out.push(n);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (depth === 0) break;
        depth--;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }
  hex() {
    const b = this.bytes;
    this.pos++;
    let digits = "";
    while (this.pos < b.length && b[this.pos] !== 62) {
      const c = b[this.pos++];
      if (!WHITE.has(c)) digits += String.fromCharCode(c);
    }
    this.pos++;
    if (digits.length % 2) digits += "0";
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  }
  dict() {
    const map = new Map<string, Value>();
    for (let guard = 0; guard < 10_000; guard++) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) break;
      if (this.bytes[this.pos] === 62 && this.bytes[this.pos + 1] === 62) {
        this.pos += 2;
        break;
      }
      const key = this.next();
      const value = this.next();
      if (key === undefined || value === undefined) break;
      if (isName(key)) map.set(key.name, value);
    }
    return map;
  }
  /** Imagem dentro do conteúdo (BI … ID dados EI): pula os bytes. */
  skipInlineImage() {
    const b = this.bytes;
    for (let guard = 0; guard < 10_000; guard++) {
      const value = this.next();
      if (value === undefined) return;
      if (value && typeof value === "object" && "op" in value && value.op === "ID") break;
    }
    this.pos++;
    while (this.pos + 1 < b.length) {
      if (b[this.pos] === 69 && b[this.pos + 1] === 73 && WHITE.has(b[this.pos - 1]) && (this.pos + 2 >= b.length || WHITE.has(b[this.pos + 2]))) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
    this.pos = b.length;
  }
}

/* ------------------------------------------------------------------------ */
/* Fontes                                                                    */
/* ------------------------------------------------------------------------ */

type Font = { bytes: 1 | 2; unicode: (code: number) => string; width: (code: number) => number };

// WinAnsi 0x80–0x9F; o resto coincide com Latin-1.
const WIN_ANSI: Record<number, string> = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ", 142: "Ž",
  145: "‘", 146: "’", 147: "“", 148: "”", 149: "•", 150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ",
};
const winAnsi = (code: number) => WIN_ANSI[code] ?? String.fromCharCode(code);
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")",
  asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", underscore: "_",
  degree: "°", ordfeminine: "ª", ordmasculine: "º", ccedilla: "ç", Ccedilla: "Ç", atilde: "ã", Atilde: "Ã", otilde: "õ", Otilde: "Õ", aacute: "á",
  Aacute: "Á", eacute: "é", Eacute: "É", iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó", uacute: "ú", Uacute: "Ú", acircumflex: "â",
  Acircumflex: "Â", ecircumflex: "ê", Ecircumflex: "Ê", ocircumflex: "ô", Ocircumflex: "Ô", agrave: "à", Agrave: "À",
};
const glyphName = (name: string) => (name.length === 1 ? name : GLYPHS[name] ?? (/^uni[0-9A-F]{4}$/.test(name) ? String.fromCharCode(parseInt(name.slice(3), 16)) : ""));

function streamBytes(doc: PDFDocument, value: unknown): Uint8Array | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(resolved instanceof PDFRawStream)) return null;
  try {
    return decodePDFRawStream(resolved).decode();
  } catch {
    return null;
  }
}
const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};
const utf16 = (hex: string) => {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
};

/** CMap ToUnicode: bfchar e bfrange (com destino único ou lista). */
function parseToUnicode(text: string) {
  const map = new Map<number, string>();
  let bytes: 1 | 2 | null = null;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  const first = space && /<([0-9a-fA-F]+)>/.exec(space[1]);
  if (first) bytes = first[1].length <= 2 ? 1 : 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const entry of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(entry[1], 16), utf16(entry[2]));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const entry of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const low = parseInt(entry[1], 16),
        high = Math.min(parseInt(entry[2], 16), low + 0xffff);
      if (entry[3].startsWith("[")) {
        const list = [...entry[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((item) => utf16(item[1]));
        for (let code = low; code <= high && code - low < list.length; code++) map.set(code, list[code - low]);
      } else {
        const hex = entry[3].slice(1, -1);
        const base = utf16(hex);
        for (let code = low; code <= high; code++) {
          const last = base.charCodeAt(base.length - 1) + (code - low);
          map.set(code, base.slice(0, -1) + String.fromCharCode(last));
        }
      }
    }
  return { map, bytes };
}

const num = (value: unknown) => (value instanceof PDFNumber ? value.asNumber() : 0);
function loadFont(doc: PDFDocument, dict: PDFDict): Font {
  const subtype = dict.lookup(PDFName.of("Subtype"));
  const toUnicodeBytes = streamBytes(doc, dict.get(PDFName.of("ToUnicode")));
  const cmap = toUnicodeBytes ? parseToUnicode(latin1(toUnicodeBytes)) : null;
  if (subtype === PDFName.of("Type0")) {
    const descendants = dict.lookup(PDFName.of("DescendantFonts"));
    const cid = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    const widths = new Map<number, number>();
    let fallback = 1000;
    if (cid instanceof PDFDict) {
      if (cid.lookup(PDFName.of("DW")) instanceof PDFNumber) fallback = num(cid.lookup(PDFName.of("DW")));
      const w = cid.lookup(PDFName.of("W"));
      const list = w instanceof PDFArray ? w.asArray().map((item) => doc.context.lookup(item) ?? item) : [];
      for (let i = 0; i < list.length; ) {
        const start = num(list[i]);
        const next = list[i + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((item, k) => widths.set(start + k, num(doc.context.lookup(item) ?? item)));
          i += 2;
        } else {
          const end = num(next),
            value = num(list[i + 2]);
          for (let code = start; code <= end && code - start < 70_000; code++) widths.set(code, value);
          i += 3;
        }
      }
    }
    return { bytes: 2, unicode: (code) => cmap?.map.get(code) ?? "", width: (code) => widths.get(code) ?? fallback };
  }
  // Fontes simples: TrueType/Type1/Type3.
  const firstChar = num(dict.lookup(PDFName.of("FirstChar")));
  const widthList = dict.lookup(PDFName.of("Widths"));
  const widths = widthList instanceof PDFArray ? widthList.asArray().map((item) => num(doc.context.lookup(item) ?? item)) : [];
  const descriptor = dict.lookup(PDFName.of("FontDescriptor"));
  const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("MissingWidth"))) : 0;
  const differences = new Map<number, string>();
  const encoding = dict.lookup(PDFName.of("Encoding"));
  if (encoding instanceof PDFDict) {
    const list = encoding.lookup(PDFName.of("Differences"));
    let code = 0;
    if (list instanceof PDFArray)
      for (const item of list.asArray()) {
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) differences.set(code++, glyphName(item.asString().slice(1)));
      }
  }
  const scale = widths.length ? 1 : 0;
  return {
    bytes: 1,
    unicode: (code) => cmap?.map.get(code) ?? (differences.has(code) ? differences.get(code)! : winAnsi(code)),
    width: (code) => (scale && code >= firstChar && code - firstChar < widths.length ? widths[code - firstChar] : missing || 500),
  };
}

/* ------------------------------------------------------------------------ */

type State = { ctm: Matrix; font: Font | null; fontSize: number; charSpacing: number; wordSpacing: number; scale: number; leading: number; rise: number };

/** Texto da página (padrão: a primeira). */
export function pageText(doc: PDFDocument, index = 0): PageText {
  const page = doc.getPage(index);
  const { width, height } = page.getSize();
  const runs: TextRun[] = [];
  const fontCache = new Map<PDFDict, Font>();
  const fontsOf = (resources: PDFDict | undefined) => {
    const fonts = resources?.lookup(PDFName.of("Font"));
    return fonts instanceof PDFDict ? fonts : undefined;
  };
  function font(resources: PDFDict | undefined, name: string): Font | null {
    const entry = fontsOf(resources)?.lookup(PDFName.of(name));
    if (!(entry instanceof PDFDict)) return null;
    let loaded = fontCache.get(entry);
    if (!loaded) {
      loaded = loadFont(doc, entry);
      fontCache.set(entry, loaded);
    }
    return loaded;
  }

  function run(content: Uint8Array, resources: PDFDict | undefined, start: Matrix, depth: number) {
    const lexer = new Lexer(content);
    let state: State = { ctm: start, font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0 };
    const stack: State[] = [];
    let tm: Matrix = IDENTITY,
      tlm: Matrix = IDENTITY;
    let operands: Value[] = [];
    const show = (parts: Value[]) => {
      if (!state.font) return;
      const f = state.font;
      const begin = multiply(multiply([state.fontSize * state.scale, 0, 0, state.fontSize, 0, state.rise], tm), state.ctm);
      let text = "",
        advance = 0;
      for (const part of parts) {
        if (typeof part === "number") {
          advance += (-part / 1000) * state.fontSize * state.scale;
          continue;
        }
        if (!(part instanceof Uint8Array)) continue;
        for (let i = 0; i + f.bytes <= part.length; i += f.bytes) {
          const code = f.bytes === 2 ? (part[i] << 8) | part[i + 1] : part[i];
          text += f.unicode(code);
          advance += ((f.width(code) / 1000) * state.fontSize + state.charSpacing + (f.bytes === 1 && code === 32 ? state.wordSpacing : 0)) * state.scale;
        }
      }
      const end = multiply([1, 0, 0, 1, advance, 0], tm);
      tm = end;
      const clean = text.replace(/\s+/g, " ").trim();
      if (!clean) return;
      const [x0, y0] = apply(begin, 0, 0);
      const [x1, y1] = apply(multiply(multiply([state.fontSize * state.scale, 0, 0, state.fontSize, 0, state.rise], end), state.ctm), 0, 0);
      const size = Math.hypot(begin[2], begin[3]);
      const rotated = Math.abs(begin[1]) > Math.abs(begin[0]) * 0.2;
      runs.push({ text: clean, x: x0, y: y0, width: Math.hypot(x1 - x0, y1 - y0), size: Math.abs(size) || state.fontSize, rotated });
    };
    for (let guard = 0; guard < 2_000_000; guard++) {
      const token = lexer.next();
      if (token === undefined) break;
      if (!(token && typeof token === "object" && "op" in token)) {
        operands.push(token);
        if (operands.length > 64) operands = operands.slice(-64);
        continue;
      }
      const op = token.op;
      const n = (i: number) => (typeof operands[i] === "number" ? (operands[i] as number) : 0);
      switch (op) {
        case "q":
          stack.push({ ...state });
          break;
        case "Q":
          state = stack.pop() || state;
          break;
        case "cm":
          if (operands.length >= 6) state.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], state.ctm);
          break;
        case "BT":
          tm = tlm = IDENTITY;
          break;
        case "Tf":
          state.font = isName(operands[0]) ? font(resources, operands[0].name) : null;
          state.fontSize = n(1);
          break;
        case "Tc":
          state.charSpacing = n(0);
          break;
        case "Tw":
          state.wordSpacing = n(0);
          break;
        case "Tz":
          state.scale = n(0) / 100;
          break;
        case "TL":
          state.leading = n(0);
          break;
        case "Ts":
          state.rise = n(0);
          break;
        case "Td":
          tm = tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
          break;
        case "TD":
          state.leading = -n(1);
          tm = tlm = multiply([1, 0, 0, 1, n(0), n(1)], tlm);
          break;
        case "Tm":
          tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
          break;
        case "T*":
          tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          break;
        case "Tj":
          show([operands[0]]);
          break;
        case "TJ":
          show(Array.isArray(operands[0]) ? operands[0] : []);
          break;
        case "'":
          tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          show([operands[0]]);
          break;
        case '"':
          state.wordSpacing = n(0);
          state.charSpacing = n(1);
          tm = tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm);
          show([operands[2]]);
          break;
        case "BI":
          lexer.skipInlineImage();
          break;
        case "Do": {
          if (depth >= 8 || !isName(operands[0])) break;
          const xobjects = resources?.lookup(PDFName.of("XObject"));
          const ref = xobjects instanceof PDFDict ? xobjects.get(PDFName.of(operands[0].name)) : undefined;
          const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
          if (!(stream instanceof PDFRawStream) || stream.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Form")) break;
          const bytes = streamBytes(doc, stream);
          if (!bytes) break;
          const matrix = stream.dict.lookup(PDFName.of("Matrix"));
          const m = matrix instanceof PDFArray && matrix.size() === 6 ? (matrix.asArray().map(num) as Matrix) : IDENTITY;
          const inner = stream.dict.lookup(PDFName.of("Resources"));
          run(bytes, inner instanceof PDFDict ? inner : resources, multiply(m, state.ctm), depth + 1);
          break;
        }
      }
      operands = [];
    }
  }

  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const parts = streams.map((item) => streamBytes(doc, item)).filter((item): item is Uint8Array => !!item);
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length + 1, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    joined[offset + part.length] = 10;
    offset += part.length + 1;
  }
  run(joined, page.node.Resources(), IDENTITY, 0);
  return { width, height, box: page.getMediaBox(), runs };
}
