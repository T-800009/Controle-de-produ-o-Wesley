import { normalize, type Dataset, type Row } from "./materials.ts";
import { consolidateBomRows } from "./report.ts";
import { addFixedBomItems } from "./bom-additions.ts";
import { manualCheckKey } from "./warehouse.ts";
import type { OpStatuses } from "./op-status.ts";

/**
 * SALDO 7000 × PROJETOS
 *
 * Cada BOM cadastrada é tratada como um projeto. Para cada material com saldo
 * livre no 7000, a análise mostra em quais projetos ele é usado, quanto as OPs
 * abertas ainda precisam e quanto sobra para devolver ao 2000.
 *
 * Regras:
 * - OP marcada como Concluída e item marcado como OK não geram demanda.
 * - Com MB51 lida: demanda da OP = máximo(BOM − consumo efetivo, 0). OP sem
 *   movimentos 261/262 é tratada como não iniciada (BOM cheia). Consumo sem
 *   conciliação confiável também conta a BOM cheia (lado seguro: não devolver).
 * - Sem MB51: demanda = BOM × OPs abertas.
 * - O saldo é distribuído uma única vez: primeiro projetos "Em produção", depois
 *   "Vai entrar", na ordem da lista. O restante é a devolução ao 2000.
 * - A mesma OP em duas BOMs consideradas conta somente na primeira.
 * - Unidade diferente, saldo negativo, saldo desconhecido ou BOM sem quantidade
 *   ficam em Conferir; nunca viram devolução automática.
 * - Nada é reservado ou movimentado: é uma orientação para o Warehouse.
 */

export type ProjectRole = "active" | "incoming" | "excluded";
export const PROJECT_ROLES: readonly ProjectRole[] = ["active", "incoming", "excluded"];
export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  active: "Em produção",
  incoming: "Vai entrar",
  excluded: "Fora da análise",
};
export function isProjectRole(value: unknown): value is ProjectRole {
  return PROJECT_ROLES.includes(value as ProjectRole);
}

export type ProjectInput = {
  id: string;
  name: string;
  revision: string;
  role: ProjectRole;
  ops: string[];
  /** BOM salva no portal (Material, UMB, Qtd.necessária por OP, classe). */
  rows: Row[];
  /** shortageReport(...).allRows depois da leitura da MB51. null = BOM cheia. */
  consumption?: Row[] | null;
  statuses?: OpStatuses;
  checks?: Record<string, boolean>;
  /** BOM do plano (OEBOM): ônibus restantes. Definido = demanda por ônibus, sem OPs/MB51. */
  units?: number | null;
};

export type ProjectUse = {
  projectId: string;
  label: string;
  role: ProjectRole;
  unit: string;
  perOp: number | null;
  classes: string[];
  openOps: string[];
  demand: number | null;
  allocated: number | null;
  basis: "mb51" | "bom" | "plan";
  /** Ônibus restantes (somente BOM do plano). */
  units: number | null;
  /** OPs abertas contadas pela BOM cheia por falta de consumo confiável. */
  uncertainOps: number;
  /** OPs abertas sem movimento na MB51 (não iniciadas). */
  notStartedOps: number;
};

export type StockProjectState = "return_all" | "return_excess" | "keep" | "review";
export const STOCK_PROJECT_LABELS: Record<StockProjectState, string> = {
  return_all: "Devolver tudo ao 2000",
  return_excess: "Devolver excedente ao 2000",
  keep: "Manter no 7000",
  review: "Conferir antes de mover",
};
export const STOCK_PROJECT_ORDER: StockProjectState[] = ["return_all", "return_excess", "review", "keep"];

export type StockProjectItem = {
  key: string;
  material: string;
  description: string;
  unit: string;
  balance: number | null;
  value: number | null;
  unitValue: number | null;
  classes: string[];
  uses: ProjectUse[];
  excludedUses: ProjectUse[];
  unitMismatch: string[];
  demand: number | null;
  keep: number | null;
  returnQty: number | null;
  returnValue: number | null;
  shortfall: number | null;
  state: StockProjectState;
  reason: string;
};

export type ProjectSummary = {
  id: string;
  label: string;
  role: ProjectRole;
  totalOps: number;
  openOps: number;
  closedOps: number;
  duplicateOps: string[];
  checkedItems: number;
  uncertainOps: number;
  notStartedOps: number;
  basis: "mb51" | "bom" | "plan";
  units: number | null;
  materials: number;
  stockMaterials: number;
  keep: Record<string, number>;
};

const canonical = (value: unknown) =>
  normalize(
    String(value ?? "")
      .trim()
      .replace(/\.0+$/, ""),
  );
const round = (value: number) => Math.round(value * 1e9) / 1e9;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stockKey = (material: unknown, unit: unknown) => JSON.stringify([canonical(material), canonical(unit)]);
const qty = (value: number, unit: string) =>
  value.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) + (unit ? " " + unit : "");
export const projectLabel = (project: { name: string; revision: string }) =>
  [project.name, project.revision].filter((part) => String(part || "").trim()).join(" · ") || "Projeto";

/** Allocation order: projects in production first, then the incoming one. */
export function projectPriority<T extends { role: ProjectRole }>(projects: T[]): T[] {
  return [
    ...projects.filter((project) => project.role === "active"),
    ...projects.filter((project) => project.role === "incoming"),
  ];
}

type Demand = {
  material: string;
  unit: string;
  description: string;
  perOp: number | null;
  classes: string[];
  openOps: string[];
  demand: number | null;
  uncertainOps: number;
  notStartedOps: number;
};

/** Remaining demand of one project, per material + unit, for its open OPs. */
export function projectDemand(
  project: ProjectInput,
  claimed: Set<string> = new Set(),
  completeElsewhere: Set<string> = new Set(),
) {
  if (project.units !== undefined && project.units !== null) return planDemand(project, project.units);
  const ops = [...new Set((project.ops || []).map((op) => String(op).trim()).filter(Boolean))];
  const open: string[] = [],
    duplicateOps: string[] = [];
  let closedOps = 0;
  for (const op of ops) {
    // The first BOM (by priority) owns an OP, open or closed. A duplicate BOM
    // never revives an OP that is already concluded in another BOM.
    if (claimed.has(op)) duplicateOps.push(op);
    else {
      claimed.add(op);
      if (project.statuses?.[op]?.status === "complete" || completeElsewhere.has(op)) closedOps++;
      else open.push(op);
    }
  }
  const basis: "mb51" | "bom" = project.consumption ? "mb51" : "bom";
  const index = new Map<string, Row>(),
    missingOrders = new Set<string>();
  for (const row of project.consumption || []) {
    index.set(String(row.op) + "|" + stockKey(row.material, row.unit), row);
    if (row.consumptionCoverage === "missing_order") missingOrders.add(String(row.op));
  }
  const bom = consolidateBomRows(addFixedBomItems(project.rows || [], ops), ops);
  const demands = new Map<string, Demand>();
  const units = new Map<string, Set<string>>();
  let checkedItems = 0,
    uncertainOps = 0;
  for (const row of bom) {
    const material = String(row.material ?? "").trim(),
      unit = String(row.unit ?? "").trim();
    if (!material) continue;
    const key = stockKey(material, unit);
    const materialUnits = units.get(canonical(material)) || new Set<string>();
    materialUnits.add(unit);
    units.set(canonical(material), materialUnits);
    const required = finite(row.required) && row.required >= 0 ? row.required : null;
    const cls = String(row.classification ?? "")
      .trim()
      .toUpperCase();
    const item: Demand = demands.get(key) || {
      material,
      unit,
      description: String(row.description ?? ""),
      perOp: required,
      classes: [],
      openOps: [],
      demand: 0,
      uncertainOps: 0,
      notStartedOps: 0,
    };
    if (cls && !item.classes.includes(cls)) item.classes.push(cls);
    demands.set(key, item);
    for (const op of open) {
      if (project.checks?.[manualCheckKey({ op, material: row.material, unit: row.unit })]) {
        checkedItems++;
        continue;
      }
      let need: number | null = required;
      if (project.consumption) {
        const found = index.get(op + "|" + key);
        if (found?.completion === "complete") need = 0;
        else if (found?.completion === "pending" && finite(found.pending)) need = found.pending;
        else if (found?.consumptionCoverage === "missing_order") {
          need = required;
          item.notStartedOps++;
        } else if (found?.completion === "review" && finite(found.pending)) need = found.pending;
        else {
          // No trustworthy consumption: keep the full BOM quantity (safe side).
          need = required;
          if (required !== null) {
            item.uncertainOps++;
            uncertainOps++;
          }
        }
      }
      if (need === null || item.demand === null) {
        item.demand = null;
        continue;
      }
      if (need > 0) {
        item.demand = round(item.demand + need);
        if (!item.openOps.includes(op)) item.openOps.push(op);
      }
    }
  }
  return {
    demands,
    units,
    summary: {
      totalOps: ops.length,
      openOps: open.length,
      closedOps,
      duplicateOps,
      checkedItems,
      uncertainOps,
      /** Open OPs without any 261/262 in the MB51 read: counted as not started. */
      notStartedOps: open.filter((op) => missingOrders.has(op)).length,
      basis: basis as "mb51" | "bom" | "plan",
      units: null as number | null,
    },
  };
}

/** BOM do plano: quantidade por ônibus × ônibus restantes (sem OPs, sem MB51). */
export function planDemand(project: ProjectInput, units: number) {
  const demands = new Map<string, Demand>();
  const unitsByMaterial = new Map<string, Set<string>>();
  const buses = Number.isFinite(units) && units > 0 ? units : 0;
  for (const row of project.rows || []) {
    const material = String(row.material ?? "").trim(),
      unit = String(row.unit ?? "").trim();
    if (!material) continue;
    const key = stockKey(material, unit);
    const set = unitsByMaterial.get(canonical(material)) || new Set<string>();
    set.add(unit);
    unitsByMaterial.set(canonical(material), set);
    const perBus = finite(row.required) && row.required >= 0 ? row.required : null;
    const found = demands.get(key);
    if (found) {
      found.perOp = found.perOp === null || perBus === null ? null : round(found.perOp + perBus);
      found.demand = found.perOp === null ? null : round(found.perOp * buses);
      continue;
    }
    demands.set(key, {
      material,
      unit,
      description: String(row.description ?? ""),
      perOp: perBus,
      classes: [],
      openOps: [],
      demand: perBus === null ? null : round(perBus * buses),
      uncertainOps: 0,
      notStartedOps: 0,
    });
  }
  return {
    demands,
    units: unitsByMaterial,
    summary: {
      totalOps: 0,
      openOps: 0,
      closedOps: 0,
      duplicateOps: [] as string[],
      checkedItems: 0,
      uncertainOps: 0,
      notStartedOps: 0,
      basis: "plan" as const,
      units: buses,
    },
  };
}

type StockGroup = {
  key: string;
  material: string;
  description: string;
  unit: string;
  balance: number | null;
  value: number | null;
};

/** Sum 7000 rows by material + unit (BR02). Unknown quantities stay unknown. */
export function stock7000Groups(stock: Dataset | null): StockGroup[] {
  const groups = new Map<string, StockGroup>();
  for (const row of stock?.rows || []) {
    if (row.depot && canonical(row.depot) !== canonical("7000")) continue;
    if (row.center && canonical(row.center) !== canonical("BR02")) continue;
    const material = String(row.material ?? "").trim();
    if (!material) continue;
    const unit = String(row.unit ?? "").trim(),
      key = stockKey(material, unit);
    const group = groups.get(key) || { key, material, description: "", unit, balance: 0, value: 0 };
    if (!group.description && row.description) group.description = String(row.description);
    group.balance = group.balance === null || !finite(row.quantity) ? null : round(group.balance + row.quantity);
    group.value = group.value === null || !finite(row.value) ? null : round(group.value + row.value);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function stockProjectsReport(stock: Dataset | null, projects: ProjectInput[]) {
  const considered = projectPriority(projects),
    excluded = projects.filter((project) => project.role === "excluded");
  const claimed = new Set<string>();
  // An OP concluded in any considered BOM is concluded everywhere.
  const completeAnywhere = new Set(
    considered.flatMap((project) =>
      Object.entries(project.statuses || {})
        .filter(([, value]) => value?.status === "complete")
        .map(([op]) => op),
    ),
  );
  const prepared = [
    ...considered.map((project) => ({ project, ...projectDemand(project, claimed, completeAnywhere) })),
    // Excluded projects are only informational ("também usado em ...").
    ...excluded.map((project) => ({ project, ...projectDemand(project, new Set()) })),
  ];
  const summaries = new Map<string, ProjectSummary>();
  for (const { project, demands, summary } of prepared)
    summaries.set(project.id, {
      id: project.id,
      label: projectLabel(project),
      role: project.role,
      ...summary,
      materials: demands.size,
      stockMaterials: 0,
      keep: {},
    });

  const items: StockProjectItem[] = [];
  let zeroBalance = 0;
  for (const group of stock7000Groups(stock)) {
    if (group.balance === 0) {
      zeroBalance++;
      continue;
    }
    const uses: ProjectUse[] = [],
      excludedUses: ProjectUse[] = [],
      unitMismatch: string[] = [];
    for (const { project, demands, units, summary } of prepared) {
      const found = demands.get(group.key);
      if (!found) {
        const other = [...(units.get(canonical(group.material)) || [])].filter(
          (unit) => canonical(unit) !== canonical(group.unit),
        );
        if (other.length && project.role !== "excluded")
          unitMismatch.push(`${projectLabel(project)}: BOM em ${other.join("/")}`);
        continue;
      }
      const use: ProjectUse = {
        projectId: project.id,
        label: projectLabel(project),
        role: project.role,
        unit: found.unit,
        perOp: found.perOp,
        classes: [...found.classes].sort(),
        openOps: [...found.openOps].sort(),
        demand: found.demand,
        allocated: null,
        basis: summary.basis,
        units: summary.units,
        uncertainOps: found.uncertainOps,
        notStartedOps: found.notStartedOps,
      };
      (project.role === "excluded" ? excludedUses : uses).push(use);
    }
    const classes = [...new Set([...uses, ...excludedUses].flatMap((use) => use.classes))].sort();
    const item: StockProjectItem = {
      key: group.key,
      material: group.material,
      description: group.description,
      unit: group.unit,
      balance: group.balance,
      value: group.value,
      unitValue:
        group.value !== null && group.balance !== null && group.balance > 0
          ? group.value / group.balance
          : null,
      classes,
      uses,
      excludedUses,
      unitMismatch,
      demand: null,
      keep: null,
      returnQty: null,
      returnValue: null,
      shortfall: null,
      state: "review",
      reason: "",
    };
    // Prefer the BOM description when the 7000 export has none.
    if (!group.description) {
      const described = [...prepared]
        .map(({ demands }) => demands.get(group.key)?.description)
        .find((text) => text && text.trim());
      item.description = described || "";
    }
    for (const use of [...uses, ...excludedUses]) {
      const summary = summaries.get(use.projectId);
      if (summary) summary.stockMaterials++;
    }
    items.push(item);

    if (group.balance === null) {
      item.reason = "Saldo 7000 não confirmado na leitura. Confira a aba 7000 antes de devolver.";
      continue;
    }
    if (group.balance < 0) {
      item.reason = "Saldo negativo no 7000. Regularize o estoque antes de qualquer devolução.";
      continue;
    }
    if (!canonical(group.unit)) {
      item.reason = "Unidade ausente na aba 7000. Sem unidade não é possível comparar com as BOMs.";
      continue;
    }
    if (!uses.length && unitMismatch.length) {
      item.reason = `Unidade do 7000 (${group.unit}) diferente da BOM — ${unitMismatch.join("; ")}. Não há conversão automática.`;
      continue;
    }
    const unknown = uses.find((use) => use.demand === null);
    if (unknown) {
      item.reason = `Quantidade da BOM ausente ou inválida em ${unknown.label}. Confira a BOM antes de devolver.`;
      continue;
    }
    const balance = group.balance;
    let remaining = balance;
    for (const use of uses) {
      use.allocated = round(Math.min(remaining, use.demand!));
      remaining = round(remaining - use.allocated);
      const summary = summaries.get(use.projectId);
      if (summary && use.allocated > 0)
        summary.keep[group.unit] = round((summary.keep[group.unit] || 0) + use.allocated);
    }
    const demand = round(uses.reduce((sum, use) => sum + use.demand!, 0));
    item.demand = demand;
    item.keep = round(balance - remaining);
    item.returnQty = remaining;
    item.shortfall = round(Math.max(0, demand - balance));
    item.returnValue = item.unitValue === null ? null : round(item.unitValue * remaining);
    const notes: string[] = [];
    if (unitMismatch.length)
      notes.push(`Atenção: ${unitMismatch.join("; ")} (unidade diferente, não somada).`);
    const uncertain = uses.reduce((sum, use) => sum + use.uncertainOps, 0);
    if (uncertain)
      notes.push(`${uncertain} OP(s) sem consumo confiável foram contadas pela BOM cheia.`);
    const note = notes.length ? " " + notes.join(" ") : "";
    if (!uses.length) {
      item.state = "return_all";
      item.reason =
        (excludedUses.length
          ? `Usado somente em projeto fora da análise (${excludedUses.map((use) => use.label).join(", ")}).`
          : "Não aparece em nenhuma BOM considerada.") + ` Devolver ${qty(balance, group.unit)} ao 2000.`;
    } else if (item.keep === 0) {
      item.state = "return_all";
      item.reason =
        `Usado em ${uses.map((use) => use.label).join(", ")}, mas ${uses.every((use) => use.basis === "plan") ? "não há ônibus restantes nesses projetos" : "as OPs abertas não precisam mais dele"}.` +
        ` Devolver ${qty(balance, group.unit)} ao 2000.` +
        note;
    } else if (remaining > 0) {
      item.state = "return_excess";
      item.reason =
        `Manter ${qty(item.keep, group.unit)} para ${uses
          .filter((use) => use.allocated! > 0)
          .map((use) => use.label)
          .join(" + ")}; devolver ${qty(remaining, group.unit)} ao 2000.` + note;
    } else {
      item.state = "keep";
      item.reason =
        `Todo o saldo é necessário para ${uses
          .filter((use) => use.allocated! > 0)
          .map((use) => use.label)
          .join(" + ")}.` +
        (item.shortfall > 0
          ? ` Ainda faltam ${qty(item.shortfall, group.unit)} no 7000 para a demanda restante.`
          : "") +
        note;
    }
  }
  items.sort(
    (a, b) =>
      STOCK_PROJECT_ORDER.indexOf(a.state) - STOCK_PROJECT_ORDER.indexOf(b.state) ||
      a.material.localeCompare(b.material) ||
      a.unit.localeCompare(b.unit),
  );
  const count = (state: StockProjectState) => items.filter((item) => item.state === state).length;
  const returnValue = items.reduce((sum, item) => sum + (item.returnValue || 0), 0);
  const returnWithoutValue = items.filter(
    (item) => (item.returnQty || 0) > 0 && item.returnValue === null,
  ).length;
  return {
    items,
    projects: [...summaries.values()],
    zeroBalance,
    counts: {
      return_all: count("return_all"),
      return_excess: count("return_excess"),
      keep: count("keep"),
      review: count("review"),
    },
    returnValue: round(returnValue),
    returnWithoutValue,
  };
}
export type StockProjectsReport = ReturnType<typeof stockProjectsReport>;

/** Complete filtered result for Excel; never only the visible page. */
export function stockProjectsExportRows(items: StockProjectItem[]) {
  const uses = (item: StockProjectItem) =>
    item.uses
      .map(
        (use) =>
          `${use.label} (${PROJECT_ROLE_LABELS[use.role]}): demanda ${use.demand ?? "?"} · reservado ${use.allocated ?? "?"}`,
      )
      .join(" | ");
  return {
    totals: items.map((item) => ({
      SAP: item.material,
      Descrição: item.description,
      UMB: item.unit,
      Classes: item.classes.join(" / "),
      "Saldo 7000": item.balance,
      "Valor 7000 (R$)": item.value,
      "Usado nos projetos": uses(item) || "Nenhum projeto considerado",
      "Também usado (fora da análise)": item.excludedUses.map((use) => use.label).join(" | "),
      "Demanda restante": item.demand,
      "Manter no 7000": item.keep,
      "Devolver ao 2000": item.returnQty,
      "Valor a devolver (R$)": item.returnValue,
      "Falta no 7000 p/ projetos": item.shortfall,
      Situação: STOCK_PROJECT_LABELS[item.state],
      Motivo: item.reason,
    })),
    details: items.flatMap((item) =>
      [...item.uses, ...item.excludedUses].map((use) => ({
        SAP: item.material,
        Descrição: item.description,
        UMB: item.unit,
        Projeto: use.label,
        Papel: PROJECT_ROLE_LABELS[use.role],
        "Qtd. BOM por OP/ônibus": use.perOp,
        "Ônibus restantes (plano)": use.units,
        "OPs abertas com demanda": use.openOps.length,
        OPs: use.openOps.join(" / "),
        "Demanda restante": use.role === "excluded" ? null : use.demand,
        "Reservado no 7000": use.allocated,
        Base:
          use.basis === "plan"
            ? "BOM do plano: qtd. por ônibus × ônibus restantes"
            : use.basis === "mb51"
              ? "BOM − consumo MB51/SCRAP"
              : "BOM cheia das OPs abertas",
        "OPs sem movimento MB51": use.notStartedOps,
        "OPs sem consumo confiável": use.uncertainOps,
      })),
    ),
  };
}
