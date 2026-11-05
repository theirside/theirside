import { useEffect, useState } from 'react';

/** Hash routes: #/, #/providers/:name, #/incidents, #/incidents/:id, #/settings/:tab */
export function useRoute(): string[] {
  const parse = () =>
    window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export const href = (...parts: string[]) => '#/' + parts.map(encodeURIComponent).join('/');
