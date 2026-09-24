// Minimal semver utilities — enough for comparing registry versions and
// rewriting the pinned version inside a dependency range.

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

export function parse(version) {
  if (typeof version !== 'string') return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: version.trim(),
  };
}

export function isPrerelease(version) {
  const p = parse(version);
  return !!(p && p.prerelease.length);
}

function comparePrerelease(a, b) {
  // No prerelease outranks a prerelease (1.0.0 > 1.0.0-rc.1)
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 | 0 | 1 — returns null when either side is not valid semver. */
export function compare(a, b) {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function gt(a, b) {
  return compare(a, b) === 1;
}

/** 'major' | 'minor' | 'patch' | null — the size of the bump from → to. */
export function bumpType(from, to) {
  const pf = parse(from), pt = parse(to);
  if (!pf || !pt) return null;
  if (pt.major !== pf.major) return 'major';
  // 0.x is special: a minor bump there is a breaking change in practice.
  if (pf.major === 0 && pt.minor !== pf.minor) return 'major';
  if (pt.minor !== pf.minor) return 'minor';
  if (pt.patch !== pf.patch) return 'patch';
  return null;
}

const RANGE_RE = /^(\^|~|>=|>|<=|<|=|v)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?)$/;

/**
 * Splits a simple npm range into its operator and version, e.g. "^1.2.3".
 * Returns null for anything we should not touch: "*", "latest", "workspace:*",
 * "git+https://…", "1.x", "npm:pkg@1", ">=1 <2", "1.0.0 || 2.0.0".
 */
export function parseRange(range) {
  if (typeof range !== 'string') return null;
  const r = range.trim();
  if (!r || /[|\s]/.test(r) || r.includes(' - ')) return null;
  const m = RANGE_RE.exec(r);
  if (!m) return null;
  const operator = m[1] === 'v' || m[1] === '=' ? '' : (m[1] || '');
  return { operator, version: m[2] };
}

/** Rebuilds a range around a new version, keeping the original operator. */
export function applyRange(range, newVersion) {
  const parsed = parseRange(range);
  if (!parsed) return null;
  return `${parsed.operator}${newVersion}`;
}
