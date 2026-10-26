import type { VomNode, VomScene } from "@browser-skill/vom";

/** Reuse the observation's semantic nodes. CSS classes and pixel positions are
 * deliberately absent; the interaction layer rechecks the live hit target. */
export interface ObservationEvidence {
  nodes: readonly VomNode[];
}

export interface EvidenceTarget {
  backendNodeId: number;
  frameId?: string;
}

const scopes = new Set(["form", "dialog", "table", "list", "grid", "listbox", "menu"]);
const regions = new Set(["main", "region", "section", "article"]);
const semanticAttributes = [
  "href",
  "type",
  "name",
  "title",
  "alt",
  "aria-label",
  "aria-selected",
  "aria-expanded",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-hidden",
  "readonly",
  "required",
];

/** A text change of one persistent node between two observations. */
export interface ContentChange {
  key: string;
  before: string;
  after: string;
}

export function observationEvidence(scene: VomScene): ObservationEvidence {
  return { nodes: scene.nodes };
}

/** Stable identity of an observed node within its document. */
function evidenceKey(node: VomNode): string | undefined {
  return node.backendNodeId === undefined
    ? undefined
    : `${node.frameId ?? ""}:${node.backendNodeId}`;
}

// Form state and modal layers are never tolerated as page activity.
const protectedState = (node: VomNode) =>
  node.value !== undefined || node.checked !== undefined || !!node.modal;
// Text-bearing facts that self-updating widgets rewrite (clocks often mirror
// their text into aria-label/title for assistive technology).
const contentAttributes = new Set(["aria-label", "title"]);
const content = (node: VomNode) => [
  node.text,
  node.name,
  node.attrs?.["aria-label"],
  node.attrs?.title,
];
const describe = (node: VomNode) => content(node).find((value) => value) ?? "";

function signature(
  evidence: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
): string | undefined {
  const nodes = evidence.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = (node: VomNode) => byId.get(node.domParentId ?? node.parentId ?? -1);
  const anchor =
    target &&
    nodes.find(
      (node) =>
        node.backendNodeId === target.backendNodeId &&
        (target.frameId === undefined || node.frameId === target.frameId),
    );
  if (target && !anchor) return;
  const ancestors: VomNode[] = [];
  for (let node = anchor; node && !ancestors.includes(node); node = parent(node))
    ancestors.push(node);
  // A whole list/table participates, so a changed competing option invalidates
  // a choice even when the selected row itself did not change.
  const scope =
    ancestors.find((node) => scopes.has(node.role ?? "") || scopes.has(node.tag)) ??
    ancestors.find((node) => node.modal) ??
    ancestors.find((node) => regions.has(node.role ?? "") || regions.has(node.tag)) ??
    ancestors.find((node) => ["absolute", "fixed"].includes(node.position) && node !== anchor);
  const inside = (node: VomNode) => {
    if (!scope) return true;
    const seen = new Set<number>();
    for (
      let current: VomNode | undefined = node;
      current && !seen.has(current.id);
      current = parent(current)
    ) {
      if (current.id === scope.id) return true;
      seen.add(current.id);
    }
    return false;
  };
  // Semantic decision units (forms, dialogs, lists, cards, popovers) stay exact.
  // Only page layout around the target, a <main> landmark or a page without
  // any enclosing region, may contain learned self-updating text.
  const broad = !scope || scope.role === "main" || scope.tag === "main";
  const withinAnchor = (node: VomNode) => {
    const seen = new Set<number>();
    for (
      let current: VomNode | undefined = node;
      current && !seen.has(current.id);
      current = parent(current)
    ) {
      if (current === anchor) return true;
      seen.add(current.id);
    }
    return false;
  };
  // Identity, structure, state and visibility of tolerated nodes remain checked.
  // The target itself and its contents are never tolerated.
  const tolerated = (node: VomNode) =>
    volatile?.has(evidenceKey(node) ?? "") === true &&
    !protectedState(node) &&
    (!target || (broad && !withinAnchor(node)));
  const facts = (node: VomNode, tolerate = false) => [
    node.frameId,
    node.backendNodeId,
    node.role,
    node.tag,
    tolerate ? undefined : node.name,
    tolerate ? undefined : node.text,
    node.value,
    node.checked,
    node.disabled,
    node.inert,
    node.modal,
    !!node.rect && node.rect.w > 0 && node.rect.h > 0,
    node.pointerEvents === "none",
    semanticAttributes.map((key) =>
      tolerate && contentAttributes.has(key) ? undefined : node.attrs?.[key],
    ),
  ];
  return JSON.stringify([
    scope && [scope.frameId, scope.backendNodeId],
    nodes.filter(inside).map((node) => facts(node, tolerated(node))),
    // Form state outside the action region can still determine its meaning.
    nodes
      .filter((node) => node.value !== undefined || node.checked !== undefined)
      .map((node) => facts(node)),
    nodes.filter((node) => node.modal).map((node) => facts(node)),
  ]);
}

/**
 * `volatile` lists nodes whose text (name, text, aria-label, title) may differ.
 * Without a target it applies to the whole page. With a target it applies only
 * when the target's region is a <main> landmark or the whole page, and never to
 * the target or its contents. Forms, dialogs, lists, tables, menus, sections,
 * articles and positioned panels around a target stay exact, as do form values,
 * checked states and modal layers everywhere.
 */
export function sameObservationEvidence(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
): boolean {
  const a = signature(before, target, volatile);
  return a !== undefined && a === signature(after, target, volatile);
}

/**
 * Returns the persistent, unprotected nodes whose text changed when that is the
 * only difference between two whole-page observations; otherwise undefined.
 * Added, removed, reordered or restyled nodes and any form or modal change
 * are not page activity and keep requiring a new decision.
 */
export function contentChanges(
  before: ObservationEvidence,
  after: ObservationEvidence,
  known: ReadonlySet<string> = new Set(),
): ContentChange[] | undefined {
  const previous = new Map(before.nodes.map((node) => [evidenceKey(node), node]));
  const changes: ContentChange[] = [];
  for (const node of after.nodes) {
    const key = evidenceKey(node);
    const old = key === undefined ? undefined : previous.get(key);
    if (!key || !old || known.has(key) || protectedState(node) || protectedState(old)) continue;
    if (JSON.stringify(content(old)) !== JSON.stringify(content(node)))
      changes.push({ key, before: describe(old), after: describe(node) });
  }
  const volatile = new Set([...known, ...changes.map((change) => change.key)]);
  return changes.length && sameObservationEvidence(before, after, undefined, volatile)
    ? changes
    : undefined;
}
