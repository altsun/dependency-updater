// Turns a scan result plus a selection into a branch, commits and a pull request.

import { applyUpdates } from './manifests.js';

function branchSuffix() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function summarize(manifests) {
  const rows = [];
  for (const m of manifests) {
    for (const u of m.updates) {
      rows.push(`| \`${u.name}\` | ${u.current} | **${u.next}** | ${u.bump} | \`${m.path}\` |`);
    }
  }
  return rows;
}

/**
 * @param selected manifests (already filtered to the updates the user kept)
 * @returns the created pull request
 */
export async function openUpdatePr(gh, repo, manifests, options = {}) {
  const { branchPrefix = 'deps/update' } = options;
  const [owner, name] = repo.full_name.split('/');
  const base = repo.default_branch;

  const baseRef = await gh.getRef(owner, name, base);
  const branch = `${branchPrefix}-${branchSuffix()}`;
  await gh.createBranch(owner, name, branch, baseRef.object.sha);

  let sha = null;
  for (const m of manifests) {
    const updated = applyUpdates(m.type, m.content, m.updates);
    if (updated === m.content) continue;
    const message = `chore(deps): update ${m.updates.length} dependenc${m.updates.length === 1 ? 'y' : 'ies'} in ${m.path}`;
    const res = await gh.putFile(owner, name, m.path, {
      content: updated,
      message,
      branch,
      sha: m.sha,
      encoding: m.encoding,
    });
    sha = res.commit.sha;
  }

  if (!sha) throw new Error('No file changed — nothing to open a pull request for.');

  const total = manifests.reduce((n, m) => n + m.updates.length, 0);
  const body = [
    `Automated dependency update covering **${total}** package${total === 1 ? '' : 's'}.`,
    '',
    '| Package | From | To | Bump | Manifest |',
    '| --- | --- | --- | --- | --- |',
    ...summarize(manifests),
    '',
    '> Versions come from the npm and PyPI registries. Lockfiles are **not** regenerated —',
    '> run your package manager install step before merging.',
    '',
    '<sub>Opened with dependency-updater.</sub>',
  ].join('\n');

  return gh.createPullRequest(owner, name, {
    title: `chore(deps): update ${total} dependenc${total === 1 ? 'y' : 'ies'}`,
    head: branch,
    base,
    body,
  });
}
