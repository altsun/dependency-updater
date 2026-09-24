// Manifest detection, dependency extraction, and in-place rewriting.

import { parseRange, applyRange } from './semver.js';

const IGNORED_DIR = /(^|\/)(node_modules|vendor|bower_components|\.venv|venv|site-packages|dist|build|third_party|fixtures|__tests__|test\/fixtures)(\/|$)/;

export const MANIFEST_TYPES = {
  'package.json': { ecosystem: 'npm', label: 'npm' },
  'requirements.txt': { ecosystem: 'pypi', label: 'pip' },
};

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Picks the manifest files out of a git tree listing. */
export function detectManifests(treeEntries) {
  const out = [];
  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue;
    const path = entry.path;
    if (IGNORED_DIR.test(path)) continue;
    const base = path.split('/').pop();
    let type = null;
    if (base === 'package.json') type = 'package.json';
    else if (base === 'requirements.txt' || /^requirements.*\.txt$/.test(base)) type = 'requirements.txt';
    if (type) out.push({ path, type, ecosystem: MANIFEST_TYPES[type].ecosystem });
  }
  return out;
}

/**
 * Dependencies we can safely reason about. Entries whose range we cannot
 * parse (git URLs, workspace protocols, "*", ">=1 <2") are skipped outright.
 */
export function parseManifest(type, content) {
  if (type === 'package.json') return parsePackageJson(content);
  if (type === 'requirements.txt') return parseRequirements(content);
  return [];
}

function parsePackageJson(content) {
  let pkg;
  try { pkg = JSON.parse(content); } catch { return []; }
  const deps = [];
  for (const section of NPM_SECTIONS) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, range] of Object.entries(block)) {
      const parsed = parseRange(range);
      if (!parsed) continue;
      deps.push({ name, section, range, current: parsed.version, ecosystem: 'npm' });
    }
  }
  return deps;
}

const REQ_LINE = /^([A-Za-z0-9._-]+)(\[[^\]]+\])?\s*==\s*([0-9][^\s;#]*)\s*(;.*)?$/;

function parseRequirements(content) {
  const deps = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) return;
    if (/[@\s](https?:|git\+)/.test(line)) return;
    const m = REQ_LINE.exec(line.split('#')[0].trim());
    if (!m) return;
    deps.push({
      name: m[1],
      section: 'requirements',
      range: `==${m[3]}`,
      current: m[3],
      ecosystem: 'pypi',
      line: i,
      extras: m[2] || '',
      marker: m[4] || '',
    });
  });
  return deps;
}

/** Applies a list of {name, section, range, next} updates to the raw file text. */
export function applyUpdates(type, content, updates) {
  if (type === 'package.json') return applyPackageJson(content, updates);
  if (type === 'requirements.txt') return applyRequirements(content, updates);
  throw new Error(`Unsupported manifest type: ${type}`);
}

function detectIndent(text) {
  const m = /\n(\s+)"/.exec(text);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

function applyPackageJson(content, updates) {
  const pkg = JSON.parse(content);
  for (const u of updates) {
    const block = pkg[u.section];
    if (!block || !(u.name in block)) continue;
    const next = applyRange(block[u.name], u.next);
    if (next) block[u.name] = next;
  }
  const indent = detectIndent(content);
  const out = JSON.stringify(pkg, null, indent);
  return content.endsWith('\n') ? out + '\n' : out;
}

function applyRequirements(content, updates) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  for (const u of updates) {
    if (typeof u.line !== 'number') continue;
    const original = lines[u.line];
    if (original === undefined) continue;
    // Rewrite only the version token, leaving comments and markers untouched.
    lines[u.line] = original.replace(
      new RegExp(`(^\\s*${escapeRe(u.name)}(?:\\[[^\\]]+\\])?\\s*==\\s*)${escapeRe(u.current)}`),
      `$1${u.next}`
    );
  }
  return lines.join(eol);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
