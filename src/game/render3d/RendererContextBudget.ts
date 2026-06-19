const AUXILIARY_BUDGET_STANDALONE = 8;
const AUXILIARY_BUDGET_WITH_MAIN = 4;

export type RendererContextClass = 'main' | 'auxiliary';

export type RendererContextToken = {
  readonly id: number;
  readonly label: string;
  readonly kind: RendererContextClass;
  release(): void;
};

export type RendererContextTelemetry = {
  activeMainCount: number;
  activeAuxiliaryCount: number;
  auxiliaryBudget: number;
  peakMainCount: number;
  peakAuxiliaryCount: number;
  deniedAuxiliaryCount: number;
  activeMainLabels: readonly string[];
  activeAuxiliaryLabels: readonly string[];
};

type RendererContextRecord = {
  id: number;
  kind: RendererContextClass;
  label: string;
  owner: object | null;
};

const activeContexts = new Map<number, RendererContextRecord>();
let nextContextId = 1;
let currentMainCount = 0;
let currentAuxiliaryCount = 0;
let peakMainCount = 0;
let peakAuxiliaryCount = 0;
let deniedAuxiliaryCount = 0;
let warningSerial = 0;

function auxiliaryBudget(): number {
  return currentMainCount > 0
    ? AUXILIARY_BUDGET_WITH_MAIN
    : AUXILIARY_BUDGET_STANDALONE;
}

function createToken(record: RendererContextRecord): RendererContextToken {
  let released = false;
  return {
    id: record.id,
    label: record.label,
    kind: record.kind,
    release: () => {
      if (released) return;
      released = true;
      if (!activeContexts.delete(record.id)) return;
      if (record.kind === 'main') currentMainCount--;
      else currentAuxiliaryCount--;
    },
  };
}

function labelsFor(kind: RendererContextClass): string[] {
  const labels: string[] = [];
  for (const record of activeContexts.values()) {
    if (record.kind === kind) labels.push(record.label);
  }
  return labels;
}

function warnBudgetDenied(label: string, activeAux: number, budget: number): void {
  warningSerial++;
  if (warningSerial > 4) return;
  console.warn(
    `RendererContextBudget: denied auxiliary WebGL renderer "${label}" ` +
      `(${activeAux}/${budget} auxiliary contexts active; main contexts ${currentMainCount}).`,
  );
}

export function acquireMainRendererContext(
  label: string,
  owner: object | null = null,
): RendererContextToken {
  const record: RendererContextRecord = {
    id: nextContextId++,
    kind: 'main',
    label,
    owner,
  };
  activeContexts.set(record.id, record);
  currentMainCount++;
  peakMainCount = Math.max(peakMainCount, currentMainCount);
  return createToken(record);
}

export function acquireAuxiliaryRendererContext(
  label: string,
  owner: object | null = null,
): RendererContextToken | null {
  const activeAux = currentAuxiliaryCount;
  const budget = auxiliaryBudget();
  if (activeAux >= budget) {
    deniedAuxiliaryCount++;
    warnBudgetDenied(label, activeAux, budget);
    return null;
  }

  const record: RendererContextRecord = {
    id: nextContextId++,
    kind: 'auxiliary',
    label,
    owner,
  };
  activeContexts.set(record.id, record);
  currentAuxiliaryCount++;
  peakAuxiliaryCount = Math.max(peakAuxiliaryCount, activeAux + 1);
  return createToken(record);
}


export function getRendererContextTelemetry(): RendererContextTelemetry {
  return {
    activeMainCount: currentMainCount,
    activeAuxiliaryCount: currentAuxiliaryCount,
    auxiliaryBudget: auxiliaryBudget(),
    peakMainCount,
    peakAuxiliaryCount,
    deniedAuxiliaryCount,
    activeMainLabels: labelsFor('main'),
    activeAuxiliaryLabels: labelsFor('auxiliary'),
  };
}
