// Scans a repository: find manifests, read them, resolve latest versions.

import { detectManifests, parseManifest } from './manifests.js';
import { latestVersion, pool } from './registry.js';
import { gt, bumpType, isPrerelease } from './semver.js';

export async function scanRepo(gh, repo, options = {}) {
  const { allow = { major: false, minor: true, patch: true }, maxManifests = 25 } = options;
  const [owner, name] = repo.full_name.split('/');
  const result = { repo, manifests: [], truncated: false, error: null, updateCount: 0 };

  let tree;
  try {
    tree = await gh.getTree(owner, name, repo.default_branch);
  } catch (err) {
    // Empty repositories have no tree at all — that is not a failure worth surfacing.
    result.error = err.status === 409 ? null : err.message;
    return result;
  }
  result.truncated = !!tree.truncated;

  const found = detectManifests(tree.tree || []).slice(0, maxManifests);
  if (!found.length) return result;

  await pool(found, 4, async (manifest) => {
    try {
      const file = await gh.getFile(owner, name, manifest.path, repo.default_branch);
      const deps = parseManifest(manifest.type, file.content);
      if (!deps.length) return;

      const updates = [];
      await pool(deps, 8, async (dep) => {
        const latest = await latestVersion(dep.ecosystem, dep.name);
        if (!latest || isPrerelease(latest)) return;
        if (!gt(latest, dep.current)) return;
        const bump = bumpType(dep.current, latest);
        if (!bump || !allow[bump]) return;
        updates.push({ ...dep, next: latest, bump });
      });

      if (!updates.length) return;
      updates.sort((a, b) => a.name.localeCompare(b.name));
      result.manifests.push({ ...manifest, sha: file.sha, content: file.content, encoding: file.encoding, updates });
      result.updateCount += updates.length;
    } catch (err) {
      result.error = err.message;
    }
  });

  result.manifests.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
