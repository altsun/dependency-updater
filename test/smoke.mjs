// node test/smoke.mjs — checks the pure logic that has no DOM dependency.
import assert from 'node:assert/strict';
import { compare, bumpType, parseRange, applyRange } from '../js/semver.js';
import { detectManifests, parseManifest, applyUpdates } from '../js/manifests.js';

// --- semver ---------------------------------------------------------------
assert.equal(compare('1.2.3', '1.2.4'), -1);
assert.equal(compare('2.0.0', '1.9.9'), 1);
assert.equal(compare('1.0.0', '1.0.0-rc.1'), 1);
assert.equal(compare('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
assert.equal(compare('1.0', '1.0.0'), null);

assert.equal(bumpType('1.2.3', '1.2.9'), 'patch');
assert.equal(bumpType('1.2.3', '1.5.0'), 'minor');
assert.equal(bumpType('1.2.3', '2.0.0'), 'major');
assert.equal(bumpType('0.4.1', '0.5.0'), 'major', '0.x minor is breaking');

assert.deepEqual(parseRange('^1.2.3'), { operator: '^', version: '1.2.3' });
assert.deepEqual(parseRange('1.2.3'), { operator: '', version: '1.2.3' });
assert.equal(parseRange('*'), null);
assert.equal(parseRange('workspace:*'), null);
assert.equal(parseRange('git+https://x/y.git'), null);
assert.equal(parseRange('>=1.0.0 <2.0.0'), null);
assert.equal(parseRange('1.x'), null);
assert.equal(applyRange('~1.2.3', '1.9.0'), '~1.9.0');

// --- manifest detection ---------------------------------------------------
const tree = [
  { type: 'blob', path: 'package.json' },
  { type: 'blob', path: 'node_modules/left-pad/package.json' },
  { type: 'blob', path: 'api/requirements.txt' },
  { type: 'blob', path: 'README.md' },
  { type: 'tree', path: 'src' },
];
assert.deepEqual(
  detectManifests(tree).map((m) => m.path),
  ['package.json', 'api/requirements.txt']
);

// --- package.json ---------------------------------------------------------
const pkg = JSON.stringify(
  {
    name: 'demo',
    dependencies: { lodash: '^4.17.20', local: 'file:../x', any: '*' },
    devDependencies: { vitest: '~1.0.0' },
    peerDependencies: { react: '^18.0.0' },
  },
  null,
  2
) + '\n';

const deps = parseManifest('package.json', pkg);
assert.deepEqual(deps.map((d) => d.name).sort(), ['lodash', 'vitest'], 'skips file:/* and peerDeps');

const out = applyUpdates('package.json', pkg, [
  { name: 'lodash', section: 'dependencies', next: '4.17.21' },
  { name: 'vitest', section: 'devDependencies', next: '1.6.0' },
]);
const reparsed = JSON.parse(out);
assert.equal(reparsed.dependencies.lodash, '^4.17.21');
assert.equal(reparsed.devDependencies.vitest, '~1.6.0');
assert.equal(reparsed.dependencies.local, 'file:../x', 'untouched entries survive');
assert.ok(out.endsWith('\n'), 'trailing newline preserved');

// --- requirements.txt -----------------------------------------------------
const req = [
  '# deps',
  'requests==2.28.0',
  'django[bcrypt]==4.1.0  # web',
  'flask>=2.0',
  '-r other.txt',
  'pkg @ https://example.com/pkg.whl',
  'numpy==1.24.0 ; python_version >= "3.9"',
  '',
].join('\n');

const reqDeps = parseManifest('requirements.txt', req);
assert.deepEqual(reqDeps.map((d) => d.name), ['requests', 'django', 'numpy']);

const reqOut = applyUpdates('requirements.txt', req, [
  { ...reqDeps[0], next: '2.31.0' },
  { ...reqDeps[1], next: '5.0.1' },
  { ...reqDeps[2], next: '1.26.4' },
]);
assert.ok(reqOut.includes('requests==2.31.0'));
assert.ok(reqOut.includes('django[bcrypt]==5.0.1  # web'), 'inline comment kept');
assert.ok(reqOut.includes('numpy==1.26.4 ; python_version >= "3.9"'), 'marker kept');
assert.ok(reqOut.includes('flask>=2.0'), 'non-pinned line untouched');

console.log('All smoke tests passed.');
