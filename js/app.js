import { GitHub } from './github.js';
import { scanRepo } from './scan.js';
import { openUpdatePr } from './pr.js';
import { pool, registryUrl } from './registry.js';

const TOKEN_KEY = 'dependency-updater.token';
const $ = (id) => document.getElementById(id);

const state = {
  gh: null,
  user: null,
  results: [],   // scan results that have at least one update
  cancelled: false,
};

/* ---------------------------------------------------------------- logging */

function log(msg, kind = '') {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
}

function showRateLimit() {
  const remaining = state.gh ? state.gh.rateLimit.remaining : null;
  $('rate-limit').textContent =
    remaining === null || remaining === undefined ? '' : `API còn ${remaining} request`;
}

/* ------------------------------------------------------------------- auth */

async function connect(token) {
  const gh = new GitHub(token);
  const user = await gh.getUser();
  state.gh = gh;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  $('who').textContent = '';
  const img = document.createElement('img');
  img.src = user.avatar_url;
  img.alt = '';
  $('who').append(img, document.createTextNode(user.login));
  $('who').classList.remove('hidden');
  $('sign-out').classList.remove('hidden');
  showRateLimit();
  return user;
}

$('sign-out').onclick = () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
};

/* ------------------------------------------------------------------- scan */

function readOptions() {
  return {
    affiliation: $('affiliation').value,
    org: $('org').value.trim(),
    maxRepos: Math.max(1, Number($('max-repos').value) || 50),
    allow: {
      patch: $('allow-patch').checked,
      minor: $('allow-minor').checked,
      major: $('allow-major').checked,
    },
    skipForks: $('skip-forks').checked,
    skipArchived: $('skip-archived').checked,
    skipPrivate: $('skip-private').checked,
  };
}

function filterRepos(repos, opt) {
  return repos
    .filter((r) => {
      if (opt.skipForks && r.fork) return false;
      if (opt.skipArchived && (r.archived || r.disabled)) return false;
      if (opt.skipPrivate && r.private) return false;
      if (r.size === 0) return false; // empty repository
      return true;
    })
    .slice(0, opt.maxRepos);
}

async function runScan() {
  const token = $('token').value.trim();
  if (!token) {
    alert('Hãy dán personal access token.');
    return;
  }

  const opt = readOptions();
  if (!opt.allow.patch && !opt.allow.minor && !opt.allow.major) {
    alert('Chọn ít nhất một mức nâng cấp (patch/minor/major).');
    return;
  }

  state.cancelled = false;
  state.results = [];
  $('scan').disabled = true;
  $('cancel').classList.remove('hidden');
  $('results').textContent = '';
  $('step-results').classList.add('hidden');
  $('step-progress').classList.remove('hidden');
  $('progress-bar').style.width = '0%';
  $('progress-text').textContent = 'Đang xác thực…';

  try {
    const user = await connect(token);
    log(`Đã kết nối với @${user.login}`, 'ok');

    $('progress-text').textContent = 'Đang lấy danh sách repo…';
    const raw = opt.org
      ? await state.gh.listOrgRepos(opt.org)
      : await state.gh.listRepos({ affiliation: opt.affiliation });
    const repos = filterRepos(raw, opt);
    log(`Tìm thấy ${raw.length} repo, sẽ quét ${repos.length} repo.`);

    let done = 0;
    await pool(repos, 4, async (repo) => {
      if (state.cancelled) return;
      const result = await scanRepo(state.gh, repo, { allow: opt.allow });
      done++;
      $('progress-bar').style.width = `${(done / repos.length) * 100}%`;
      $('progress-text').textContent = `${done}/${repos.length} — ${repo.full_name}`;
      showRateLimit();

      if (result.error) log(`${repo.full_name}: ${result.error}`, 'err');
      if (result.truncated) log(`${repo.full_name}: cây thư mục quá lớn, có thể bỏ sót manifest.`);
      if (result.updateCount) {
        state.results.push(result);
        renderRepo(result);
        renderSummary();
        log(`${repo.full_name}: ${result.updateCount} gói có bản mới`, 'ok');
      }
    });

    $('progress-text').textContent = state.cancelled ? 'Đã dừng.' : 'Quét xong.';
    renderSummary();
    $('step-results').classList.remove('hidden');
    if (!state.results.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Không có thư viện nào cần nâng cấp với tiêu chí đã chọn. 🎉';
      $('results').append(p);
    }
  } catch (err) {
    log(err.message, 'err');
    $('progress-text').textContent = 'Lỗi — xem nhật ký bên dưới.';
  } finally {
    $('scan').disabled = false;
    $('cancel').classList.add('hidden');
  }
}

$('scan').onclick = runScan;
$('cancel').onclick = () => {
  state.cancelled = true;
  log('Đang dừng…');
};

/* ----------------------------------------------------------------- render */

function renderSummary() {
  const repos = state.results.length;
  const updates = state.results.reduce((n, r) => n + r.updateCount, 0);
  $('results-summary').textContent = `${updates} bản nâng cấp trên ${repos} repo`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function renderRepo(result) {
  const card = el('div', { className: 'repo' });
  card.dataset.repo = result.repo.full_name;

  const repoCheck = el('input', { type: 'checkbox', className: 'repo-check', checked: true });
  const head = el('div', { className: 'repo-head' }, [
    repoCheck,
    el('span', { className: 'name', textContent: result.repo.full_name }),
    el('span', { className: 'badge', textContent: String(result.updateCount) }),
    el('span', { className: 'muted', textContent: result.repo.default_branch }),
  ]);

  const prBtn = el('button', { className: 'btn small primary pr-link', textContent: 'Tạo PR' });
  prBtn.onclick = (e) => {
    e.stopPropagation();
    createPr(result, card, prBtn);
  };
  head.append(prBtn);

  const body = el('div', { className: 'repo-body' });

  for (const manifest of result.manifests) {
    body.append(
      el('div', { className: 'manifest-path', textContent: `${manifest.path} · ${manifest.ecosystem}` })
    );

    const table = el('table', { className: 'deps' });
    table.append(
      el('tr', {}, ['', 'Gói', 'Hiện tại', 'Mới nhất', 'Mức'].map((t) => el('th', { textContent: t })))
    );

    for (const u of manifest.updates) {
      const check = el('input', { type: 'checkbox', className: 'dep-check', checked: true });
      check.dataset.key = `${manifest.path}::${u.section}::${u.name}`;

      const url = registryUrl(u.ecosystem, u.name);
      const nameCell = el('td', {}, [
        url
          ? el('a', { href: url, target: '_blank', rel: 'noopener', textContent: u.name })
          : document.createTextNode(u.name),
        el('span', { className: 'muted', textContent: ` ${u.section}` }),
      ]);

      table.append(
        el('tr', {}, [
          el('td', {}, check),
          nameCell,
          el('td', { className: 'ver', textContent: u.range }),
          el('td', { className: 'ver', textContent: u.next }),
          el('td', {}, el('span', { className: `bump ${u.bump}`, textContent: u.bump })),
        ])
      );
    }
    body.append(table);
  }

  repoCheck.onclick = (e) => {
    e.stopPropagation();
    body.querySelectorAll('.dep-check').forEach((c) => {
      c.checked = e.target.checked;
    });
  };

  card.append(head, body);
  $('results').append(card);
}

$('select-all').onclick = () =>
  document.querySelectorAll('.dep-check, .repo-check').forEach((c) => {
    c.checked = true;
  });
$('select-none').onclick = () =>
  document.querySelectorAll('.dep-check, .repo-check').forEach((c) => {
    c.checked = false;
  });

/* -------------------------------------------------------------------- PRs */

/** Rebuilds the manifest list from the checkboxes the user left ticked. */
function selectedManifests(result, card) {
  const keys = new Set(
    [...card.querySelectorAll('.dep-check')].filter((c) => c.checked).map((c) => c.dataset.key)
  );
  return result.manifests
    .map((m) => ({
      ...m,
      updates: m.updates.filter((u) => keys.has(`${m.path}::${u.section}::${u.name}`)),
    }))
    .filter((m) => m.updates.length);
}

async function createPr(result, card, btn) {
  const manifests = selectedManifests(result, card);
  if (!manifests.length) {
    log(`${result.repo.full_name}: chưa chọn gói nào.`, 'err');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Đang tạo…';
  try {
    const pr = await openUpdatePr(state.gh, result.repo, manifests);
    btn.replaceWith(
      el('a', {
        className: 'pr-link',
        href: pr.html_url,
        target: '_blank',
        rel: 'noopener',
        textContent: `PR #${pr.number} ↗`,
      })
    );
    log(`${result.repo.full_name}: đã mở PR #${pr.number}`, 'ok');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Thử lại';
    log(`${result.repo.full_name}: ${err.message}`, 'err');
  }
  showRateLimit();
}

$('create-all').onclick = async () => {
  const btn = $('create-all');
  btn.disabled = true;
  for (const card of [...document.querySelectorAll('.repo')]) {
    const result = state.results.find((r) => r.repo.full_name === card.dataset.repo);
    const prBtn = card.querySelector('button.pr-link');
    if (!result || !prBtn) continue; // no selection, or a PR already exists
    if (!selectedManifests(result, card).length) continue;
    await createPr(result, card, prBtn);
  }
  btn.disabled = false;
};

/* ------------------------------------------------------------------- boot */

const saved = localStorage.getItem(TOKEN_KEY);
if (saved) {
  $('token').value = saved;
  connect(saved).then(
    (u) => log(`Khôi phục phiên của @${u.login}`),
    () => log('Token đã lưu không còn hợp lệ.', 'err')
  );
}
