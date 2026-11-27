import { FAR_ZOOM } from "./media-activation.ts";

/**
 * UI V1: workflow link emphasis, computed from plain data so it can be tested and benchmarked.
 *
 * - idle: every link is quiet (styled in globals.css)
 * - selected node: its whole connected chain is emphasised, everything else recedes (existing behaviour)
 * - hovered node: its direct links brighten a little
 * - generating node (H3 / SeedVR2 / FILM): the links feeding it get a slow dash flow
 * Motion only exists for generating links, and only at mid/near zoom; far zoom is always static.
 */

export type Link = { id: string; from: string; to: string };

/** All links in the connected component of `focus` (upstream and downstream), like before. */
export function connectedChain(focus: string, links: readonly Link[]) {
  const byNode = new Map<string, Link[]>();
  for (const link of links) {
    for (const end of [link.from, link.to]) { const list = byNode.get(end); if (list) list.push(link); else byNode.set(end, [link]); }
  }
  const nodes = new Set([focus]); const chain = new Set<string>(); const queue = [focus];
  while (queue.length) {
    for (const link of byNode.get(queue.pop()!) ?? []) {
      if (chain.has(link.id)) continue;
      chain.add(link.id);
      for (const end of [link.from, link.to]) if (!nodes.has(end)) { nodes.add(end); queue.push(end); }
    }
  }
  return chain;
}

export const directLinks = (node: string, links: readonly Link[]) => new Set(links.filter((link) => link.from === node || link.to === node).map((link) => link.id));
export const feedingLinks = (nodes: ReadonlySet<string>, links: readonly Link[]) => new Set(links.filter((link) => nodes.has(link.to)).map((link) => link.id));

const esc = (id: string) => id.replace(/["\\]/g, "\\$&");
const shape = (id: string) => `.tl-shape[data-shape-id="${esc(id)}"]`;
const body = (id: string) => `${shape(id)} g[style*="clip-path"]>path`;

export function linkStyleRules(input: { links: readonly Link[]; selectedId?: string | null; hoveredId?: string | null; generatingIds?: ReadonlySet<string>; zoom: number; reducedMotion?: boolean }) {
  const { links, selectedId, hoveredId, zoom } = input;
  const generating = input.generatingIds ?? new Set<string>();
  const animate = zoom >= FAR_ZOOM && !input.reducedMotion;
  const rules: string[] = [];
  const chain = selectedId ? connectedChain(selectedId, links) : new Set<string>();
  const direct = selectedId ? directLinks(selectedId, links) : new Set<string>();
  rules.push(`.tl-shape[data-shape-type="arrow"]{opacity:.48}`);
  if (selectedId) {
    rules.push(`.tl-shape[data-shape-type="arrow"]{opacity:.26}`);
    for (const id of chain) rules.push(`${shape(id)}{opacity:${direct.has(id) ? ".95" : ".5"}!important;--ff-arrow-stroke:var(--ff-link-active)}`);
  }
  if (hoveredId && hoveredId !== selectedId) {
    for (const id of directLinks(hoveredId, links)) if (!chain.has(id)) rules.push(`${shape(id)}{opacity:.9!important;--ff-arrow-stroke:var(--ff-link-hover)}`);
  }
  for (const id of feedingLinks(generating, links)) {
    rules.push(`${shape(id)}{opacity:1!important;--ff-arrow-stroke:var(--ff-link-flow)}`);
    if (animate) rules.push(`${body(id)}{stroke-dasharray:7 9;animation:ff-link-flow 1.6s linear infinite}`);
  }
  return rules.join("");
}

/** Nodes currently generating (live or recovered), published by the H3 / SeedVR2 / FILM nodes. */
const generatingNodes = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = "";
export function setNodeGenerating(nodeId: string, active: boolean) {
  const had = generatingNodes.has(nodeId);
  if (active === had) return;
  if (active) generatingNodes.add(nodeId); else generatingNodes.delete(nodeId);
  snapshot = [...generatingNodes].sort().join(",");
  for (const listener of listeners) listener();
}
export const subscribeGenerating = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getGeneratingSnapshot = () => snapshot;
