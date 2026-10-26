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
  // Only the whole-page default check tolerates text that changed by itself;
  // identity, structure, state and visibility of those nodes remain checked.
  const tolerated = (node: VomNode) =>
    !target && !protectedState(node) && volatile?.has(evidenceKey(node) ?? "") === true;
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
    semanticAttributes.map((key) => node.attrs?.[key]),
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
 * `volatile` applies only to the whole-page check (no target): text of those
 * nodes may differ. Explicit dependencies and target regions stay exact.
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
    if (old.name !== node.name || old.text !== node.text)
      changes.push({
        key,
        before: old.text ?? old.name ?? "",
        after: node.text ?? node.name ?? "",
      });
  }
  const volatile = new Set([...known, ...changes.map((change) => change.key)]);
  return changes.length && sameObservationEvidence(before, after, undefined, volatile)
    ? changes
    : undefined;
}
