import { useState, useEffect } from './html.js';

function parseHash(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'trajectory' && parts[1] && parts[2]) {
    // Support #/trajectory/model/skill@timestamp
    const atIdx = parts[2].indexOf('@');
    if (atIdx >= 0) {
      const skill = parts[2].slice(0, atIdx);
      const ts = parseFloat(parts[2].slice(atIdx + 1));
      return { page: 'trajectory', model: parts[1], skill, seekTs: isNaN(ts) ? null : ts };
    }
    return { page: 'trajectory', model: parts[1], skill: parts[2] };
  }

  return { page: 'home' };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const handler = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return route;
}

export function navigate(path) {
  window.location.hash = '#/' + path;
}

export function closeModal() {
  window.location.hash = '#/';
}
