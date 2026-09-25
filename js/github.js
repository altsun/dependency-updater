// Thin GitHub REST client. Everything runs in the browser with the user's PAT.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class GitHub {
  constructor(token) {
    this.token = token;
    this.rateLimit = { remaining: null, reset: null };
  }

  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const res = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      this.rateLimit = {
        remaining: Number(remaining),
        reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
      };
    }

    if (res.status === 204) return { data: null, res };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!res.ok) {
      const msg = (data && data.message) || res.statusText;
      throw new GitHubError(`${res.status} ${msg} (${options.method || 'GET'} ${url})`, res.status, data);
    }
    return { data, res };
  }

  /** Follows Link headers until every page is collected. */
  async paginate(path, { max = 1000 } = {}) {
    let url = path.includes('?') ? `${path}&per_page=100` : `${path}?per_page=100`;
    const out = [];
    while (url && out.length < max) {
      const { data, res } = await this.request(url);
      if (!Array.isArray(data)) break;
      out.push(...data);
      const link = res.headers.get('link') || '';
      const next = /<([^>]+)>;\s*rel="next"/.exec(link);
      url = next ? next[1] : null;
    }
    return out.slice(0, max);
  }

  async getUser() {
    const { data } = await this.request('/user');
    return data;
  }

  /**
   * Repos the token can see. `affiliation=owner` keeps it to repos the user
   * actually owns; pass owner/collaborator/org to widen it.
   */
  async listRepos({ affiliation = 'owner' } = {}) {
    return this.paginate(`/user/repos?affiliation=${affiliation}&sort=pushed`);
  }

  async listOrgRepos(org) {
    return this.paginate(`/orgs/${encodeURIComponent(org)}/repos?type=all&sort=pushed`);
  }

  /** Recursive tree of the default branch. May come back truncated on huge repos. */
  async getTree(owner, repo, ref) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
    return data;
  }

  /**
   * The Contents API silently transcodes non-UTF-8 files (e.g. UTF-16) to
   * UTF-8 in its JSON response, which masks the file's real on-disk encoding.
   * We fetch the raw blob instead so we can detect and later preserve it.
   */
  async getFile(owner, repo, path, ref) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
    );
    const { data: blob } = await this.request(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    const { text, encoding } = decodeBytes(base64ToBytes(blob.content));
    return { content: text, sha: data.sha, encoding };
  }

  async getRef(owner, repo, branch) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
    );
    return data;
  }

  async createBranch(owner, repo, branch, sha) {
    const { data } = await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    return data;
  }

  async putFile(owner, repo, path, { content, message, branch, sha, encoding = 'utf-8' }) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        body: JSON.stringify({ message, content: bytesToBase64(encodeBytes(content, encoding)), branch, sha }),
      }
    );
    return data;
  }

  async createPullRequest(owner, repo, { title, head, base, body }) {
    const { data } = await this.request(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, head, base, body, maintainer_can_modify: true }),
    });
    return data;
  }
}

export function base64ToBytes(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Detects BOM-marked encodings; anything else is assumed UTF-8. */
function detectEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/** Decodes raw file bytes, reporting the detected encoding so it can be preserved on write. */
export function decodeBytes(bytes) {
  const encoding = detectEncoding(bytes);
  const decoderName = encoding === 'utf-8-bom' ? 'utf-8' : encoding;
  return { text: new TextDecoder(decoderName).decode(bytes), encoding };
}

/** Re-encodes text into the given encoding, mirroring what decodeBytes detected. */
export function encodeBytes(text, encoding) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const bytes = new Uint8Array(2 + text.length * 2);
    const le = encoding === 'utf-16le';
    bytes[0] = le ? 0xff : 0xfe;
    bytes[1] = le ? 0xfe : 0xff;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const lo = code & 0xff;
      const hi = (code >> 8) & 0xff;
      bytes[2 + i * 2] = le ? lo : hi;
      bytes[2 + i * 2 + 1] = le ? hi : lo;
    }
    return bytes;
  }
  const utf8 = new TextEncoder().encode(text);
  if (encoding === 'utf-8-bom') {
    const bytes = new Uint8Array(3 + utf8.length);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(utf8, 3);
    return bytes;
  }
  return utf8;
}
