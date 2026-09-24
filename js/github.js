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

  async getFile(owner, repo, path, ref) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
    );
    return { content: decodeBase64(data.content), sha: data.sha };
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

  async putFile(owner, repo, path, { content, message, branch, sha }) {
    const { data } = await this.request(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      {
        method: 'PUT',
        body: JSON.stringify({ message, content: encodeBase64(content), branch, sha }),
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

export function decodeBase64(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
