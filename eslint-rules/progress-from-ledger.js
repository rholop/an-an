// @ts-check
// Phase 29 Part C.2: the progress rule as a typed lint rule (CLAUDE.md "Progress rule (Phase 29)").
// Every progress number or decision comes from the ledger (`packages/core/src/progress/ledger.ts`).
// Outside `core/progress` this rule fails on:
//   1. reading a scheduling field (`due`, `stability`, `state`, `reps`, `lapses`, `last_review`) of a
//      SkillCard or an FSRS Card (found through the type checker, so `Pick<SkillCard, …>` and
//      `card.card.due` count too). Persistence (repo, backup, merge, Anki import) may store cards:
//      those lines carry `// eslint-disable-next-line anan/progress-from-ledger -- persistence: <why>`;
//   2. day arithmetic on a Date (`getDay`, `getDate`, `setHours`, `getHours`, `toDateString`):
//      days are the profile's (`core/progress/time.ts`, `ledger.dayKey`);
//   3. a number written as a threshold next to stability or retrievability: thresholds live in
//      `progress.config.ts`.

const SCHEDULING_FIELDS = new Set(['due', 'stability', 'state', 'reps', 'lapses', 'last_review']);
const DAY_METHODS = new Set(['getDay', 'getDate', 'setHours', 'getHours', 'toDateString']);
/** Interfaces whose scheduling fields only the ledger reads. */
const CARD_TYPES = new Set(['SkillCard', 'Card', 'CardInput']);
const COMPARISONS = new Set(['<', '<=', '>', '>=']);
const THRESHOLD_NAME = /stability|retrievab/i;

/** The interface a property symbol is declared on (`SkillCard`, `Card`, …), if any. */
function declaringInterface(symbol) {
  for (const decl of symbol?.declarations ?? []) {
    const parent = decl.parent;
    const name = parent?.name?.escapedText ?? parent?.name?.text;
    if (name) return String(name);
  }
  return undefined;
}

/** `x.stability`, `retrievabilityOf(…)`, `r` named like a threshold subject. */
function mentionsThresholdSubject(node) {
  if (!node) return false;
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') return THRESHOLD_NAME.test(node.property.name);
  if (node.type === 'Identifier') return THRESHOLD_NAME.test(node.name);
  if (node.type === 'CallExpression') return mentionsThresholdSubject(node.callee);
  if (node.type === 'ChainExpression') return mentionsThresholdSubject(node.expression);
  if (node.type === 'TSNonNullExpression') return mentionsThresholdSubject(node.expression);
  return false;
}

const isNumber = (node) =>
  (node?.type === 'Literal' && typeof node.value === 'number') ||
  (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Progress comes from the ledger (Phase 29): no card scheduling reads, day maths or threshold numbers outside core/progress.' },
    schema: [],
    messages: {
      field:
        "Don't read `{{field}}` of a {{type}} here: ask the progress ledger (`useLedger()` / `getLedgerNow()` / `buildLedger`). Persistence only: disable this line with `-- persistence: <why>`.",
      day: '`{{method}}()` uses the device time zone: use the ledger (`ledger.dayKey`, `ledger.weekRange`) or `core/progress/time.ts`.',
      threshold: 'A progress threshold written as a number: put it in `progress/progress.config.ts` and ask the ledger.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const typed = !!services?.program && !!services.esTreeNodeToTSNodeMap;
    const checker = typed ? services.program.getTypeChecker() : undefined;
    return {
      MemberExpression(node) {
        if (!checker || node.computed || node.property.type !== 'Identifier') return;
        const field = node.property.name;
        if (!SCHEDULING_FIELDS.has(field)) return;
        // a write (`card.state = …`) is storing, not reading
        const parent = node.parent;
        if (parent?.type === 'AssignmentExpression' && parent.left === node) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node.property);
        const symbol = checker.getSymbolAtLocation(tsNode);
        const owner = declaringInterface(symbol);
        if (!owner || !CARD_TYPES.has(owner)) return;
        context.report({ node, messageId: 'field', data: { field, type: owner } });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        if (DAY_METHODS.has(callee.property.name))
          context.report({ node, messageId: 'day', data: { method: callee.property.name } });
      },
      BinaryExpression(node) {
        if (!COMPARISONS.has(node.operator)) return;
        if ((isNumber(node.left) && mentionsThresholdSubject(node.right)) || (isNumber(node.right) && mentionsThresholdSubject(node.left)))
          context.report({ node, messageId: 'threshold' });
      },
    };
  },
};

export default { rules: { 'progress-from-ledger': rule } };
