import type { VomNode } from "@browser-skill/vom";
import { expect, it } from "vitest";
import { contentChanges, sameObservationEvidence } from "./observation-evidence";

const node = (id: number, parentId: number | null, role: string, name = ""): VomNode => ({
  id,
  parentId,
  backendNodeId: id,
  frameId: "frame",
  role,
  name,
  tag: role,
  rect: { x: 10, y: 10, w: 100, h: 20 },
  paintOrder: 1,
  position: "static",
  pointerEvents: "auto",
});
const scene = () => [
  node(1, null, "main"),
  node(2, 1, "form"),
  node(3, 2, "textbox", "Choice"),
  node(4, 2, "button", "Continue"),
  node(5, 1, "aside", "Rotating announcement"),
];
const target = { backendNodeId: 4, frameId: "frame" };

it("allows unrelated updates and cosmetic hover changes while retaining form evidence", () => {
  const before = scene();
  const after = structuredClone(before);
  after[4].name = "Next announcement";
  after[3].attrs = { class: "hovered" };
  after[3].rect!.x += 30;
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(true);
});

it.each([
  "value",
  "identity",
  "disabled",
  "overlay",
])("rejects changed %s even when the button remains", (change) => {
  const before = scene();
  const after = structuredClone(before);
  if (change === "value") after[2].value = "different";
  if (change === "identity") after[3].backendNodeId = 40;
  if (change === "disabled") after[3].disabled = true;
  if (change === "overlay") after.push({ ...node(6, 1, "dialog"), modal: true });
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
});

it("invalidates a selection when another candidate changes or the list reorders", () => {
  const before = [
    node(1, null, "list"),
    node(2, 1, "button", "A 100"),
    node(3, 1, "button", "B 120"),
  ];
  const changed = structuredClone(before);
  changed[2].name = "B 80";
  for (const after of [changed, [before[0], before[2], before[1]]])
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, { backendNodeId: 2 })).toBe(
      false,
    );
});

it("checks fields outside the action region and falls back to the whole document without a scope", () => {
  const before = scene();
  before.push({ ...node(6, 1, "textbox", "Destination"), value: "A" });
  const after = structuredClone(before);
  after[5].value = "B";
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, target)).toBe(false);
  expect(sameObservationEvidence({ nodes: scene() }, { nodes: after })).toBe(false);
});

it("identifies in-place text changes and tolerates only those in the whole-page check", () => {
  const before = scene();
  before.push({ ...node(6, 1, "timer"), text: "10:00:00" });
  const after = structuredClone(before);
  after[5].text = "10:00:01";
  expect(contentChanges({ nodes: before }, { nodes: after })).toEqual([
    { key: "frame:6", before: "10:00:00", after: "10:00:01" },
  ]);
  const volatile = new Set(["frame:6"]);
  expect(sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, volatile)).toBe(
    true,
  );
  for (const change of ["removed", "disabled", "hidden", "added"]) {
    const next = structuredClone(after);
    if (change === "removed") next.pop();
    if (change === "disabled") next[5].disabled = true;
    if (change === "hidden") next[5].rect = { x: 0, y: 0, w: 0, h: 0 };
    if (change === "added") next.push(node(7, 1, "status", "Sold out"));
    expect(sameObservationEvidence({ nodes: before }, { nodes: next }, undefined, volatile)).toBe(
      false,
    );
    expect(contentChanges({ nodes: before }, { nodes: next }, volatile)).toBeUndefined();
  }
  // Explicit targets never use the tolerated set.
  expect(
    sameObservationEvidence({ nodes: before }, { nodes: after }, { backendNodeId: 6 }, volatile),
  ).toBe(false);
});

it("never treats form values or modal content as page activity", () => {
  const before = scene();
  before.push({ ...node(6, 1, "textbox", "Amount"), value: "1" });
  before.push({ ...node(7, 1, "dialog", "Confirm"), modal: true });
  for (const index of [5, 6]) {
    const after = structuredClone(before);
    after[index].name = "changed";
    const volatile = new Set([`frame:${index + 1}`]);
    expect(contentChanges({ nodes: before }, { nodes: after })).toBeUndefined();
    expect(sameObservationEvidence({ nodes: before }, { nodes: after }, undefined, volatile)).toBe(
      false,
    );
  }
});
