// Registry lookups. Both endpoints below send permissive CORS headers, so the
// browser can query them directly with no proxy.

import { isPrerelease, compare } from './semver.js';

const cache = new Map(); // "npm:lodash" -> Promise<string|null>

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const resolvers = {
  async npm(name) {
    const data = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`);
    return data.version || null;
  },

  async pypi(name) {
    const data = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    const latest = data.info && data.info.version;
    if (latest && !isPrerelease(latest)) return latest;
    // info.version can be a prerelease; fall back to the highest stable release.
    const stable = Object.keys(data.releases || {})
      .filter((v) => !isPrerelease(v))
      .sort((a, b) => compare(a, b) ?? (a < b ? -1 : 1));
    return stable.length ? stable[stable.length - 1] : latest || null;
  },
};

/** Latest published version, or null when the package cannot be resolved. */
export function latestVersion(ecosystem, name) {
  const key = `${ecosystem}:${name}`;
  if (!cache.has(key)) {
    const resolve = resolvers[ecosystem];
    const p = resolve
      ? resolve(name).catch(() => null)
      : Promise.resolve(null);
    cache.set(key, p);
  }
  return cache.get(key);
}

export function registryUrl(ecosystem, name) {
  if (ecosystem === 'npm') return `https://www.npmjs.com/package/${name}`;
  if (ecosystem === 'pypi') return `https://pypi.org/project/${name}/`;
  return null;
}

/** Runs tasks with a bounded number of concurrent requests. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
