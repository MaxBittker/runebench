import { useState, useEffect } from './html.js';

// _data.js ships summary fields only; the heavy per-run payloads
// (trajectory steps + XP samples) live in results/skills-30m/<model>.json.
// Fetched once per model and cached for the page lifetime.
const cache = new Map();

export function loadModelDetail(model) {
  if (!cache.has(model)) {
    cache.set(model,
      fetch(`results/skills-30m/${encodeURIComponent(model)}.json`)
        .then(r => (r.ok ? r.json() : null))
        .then(j => j?.skills || null)
        .catch(() => null)
    );
  }
  return cache.get(model);
}

/** Returns the model's skills detail map ({skill: {trajectory, samples, ...}}), or null while loading. Pass a falsy model to skip fetching. */
export function useModelDetail(model) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!model) { setDetail(null); return; }
    let live = true;
    setDetail(null);
    loadModelDetail(model).then(d => { if (live) setDetail(d); });
    return () => { live = false; };
  }, [model]);
  return detail;
}
