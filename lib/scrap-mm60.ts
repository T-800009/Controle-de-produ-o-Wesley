import { anaReader } from "./ana-columns.ts";
import { anaNumber } from "./ana-check.ts";
import type { Row } from "./materials.ts";

export type Mm60Price = { price: number; description: string; unit: string };

/** MM60 → preço unitário (Preço ÷ Unidade preço) e descrição SAP de cada material. */
export function mm60Prices(rows: Row[]) {
  const reader = anaReader(rows, "MM60");
  const hasPriceUnit = !!reader.header("Unidade preço");
  const out = new Map<string, Mm60Price>();
  for (const row of rows) {
    const material = String(reader.get(row, "Material") ?? "")
      .trim()
      .toUpperCase();
    if (!material || out.has(material)) continue;
    const price = anaNumber(reader.get(row, "Preço"));
    const unit = hasPriceUnit ? anaNumber(reader.get(row, "Unidade preço")) : 1;
    if (price === null || price < 0 || unit === null || unit <= 0) continue;
    out.set(material, {
      price: Math.round((price / unit) * 100) / 100,
      description: String(reader.get(row, "Descrição") ?? "").trim(),
      unit: String(reader.get(row, "Unidade") ?? "").trim(),
    });
  }
  return out;
}
