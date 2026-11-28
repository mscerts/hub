// The navigation rules of the certification roadmap wizard (src/components/CertRoadmap.astro), kept apart from
// the component so a test can run them: which step an address names, whether a saved trail can be trusted, and the
// shortest trail to a step. Nothing here touches the document, and nothing here imports node modules (the browser
// bundles this file).

/**
 * The step an address (`location.hash`, with or without the `#`) names for a roadmap with this prefix, or null
 * when it names something else. The id of a heading (`<prefix>-<step>-title`) names its step too: the headings of
 * the page have anchors that copy their address, and search results link to them.
 * @param {string} hash
 * @param {string} prefix
 * @param {{ has(id: string): boolean }} known the steps and results of the roadmap
 * @returns {string | null}
 */
export function idFromHash(hash, prefix, known) {
  const text = String(hash ?? "").replace(/^#/, "");
  const lead = `${prefix}-`;
  if (!text.startsWith(lead)) return null;
  const rest = text.slice(lead.length);
  if (known.has(rest)) return rest;
  if (rest.endsWith("-title") && known.has(rest.slice(0, -"-title".length)))
    return rest.slice(0, -"-title".length);
  return null;
}

/**
 * A trail read from the browser's history, or null when it cannot be trusted (not a list, empty, an id the page no
 * longer has after a new deploy, a trail that does not start at `start`).
 * @param {unknown} trail
 * @param {string} start
 * @param {{ has(id: string): boolean }} known
 * @returns {{ id: string, label: string }[] | null}
 */
export function validTrail(trail, start, known) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const clean = [];
  for (const item of trail) {
    if (!item || typeof item.id !== "string" || !known.has(item.id))
      return null;
    clean.push({
      id: item.id,
      label: typeof item.label === "string" ? item.label : "",
    });
  }
  return clean[0].id === start ? clean : null;
}

/**
 * The shortest trail from `start` to `target` through the answers (`edges`: step id -> [{ to, label }]), each item
 * { id, label } with the label of the answer that led to it. A target that cannot be reached by the answers gets
 * the start and the target; an unknown target gets just the start.
 * @returns {{ id: string, label: string }[]}
 * @param {Map<string, { to: string, label: string }[]>} edges
 * @param {string} start
 * @param {string} target
 * @param {{ has(id: string): boolean }} known
 */
export function trailTo(edges, start, target, known) {
  const first = [{ id: start, label: "" }];
  if (target === start || !known.has(target)) return first;
  const seen = new Set([start]);
  const queue = [first];
  while (queue.length > 0) {
    const trail = queue.shift() ?? first;
    const last = trail[trail.length - 1];
    if (last.id === target) return trail;
    for (const edge of edges.get(last.id) ?? []) {
      if (seen.has(edge.to) || !known.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push([...trail, { id: edge.to, label: edge.label }]);
    }
  }
  return [...first, { id: target, label: "" }];
}
