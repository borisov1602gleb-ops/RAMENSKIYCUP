// Shared GitHub Contents API helpers used by the Telegram bot webhook and
// the admin-triggered draw-publish endpoint. Both read/write JSON data files
// in this same repo instead of using a separate database.

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

async function ghGetFile(path) {
  const repo = process.env.GH_REPO;
  const branch = env('GH_BRANCH', 'main');
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: {
      authorization: `token ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (r.status === 404) return { sha: null, json: null };
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutRaw(path, base64Content, sha, message) {
  const repo = process.env.GH_REPO;
  const branch = env('GH_BRANCH', 'main');
  const body = { message, content: base64Content, branch };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `token ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function ghPutFile(path, obj, sha, message) {
  return ghPutRaw(path, Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64'), sha, message);
}

async function loadJson(path, fallback) {
  const { json } = await ghGetFile(path);
  return json === null ? fallback : json;
}

async function saveJson(path, obj, message) {
  const { sha } = await ghGetFile(path);
  return ghPutFile(path, obj, sha, message);
}

module.exports = { env, ghGetFile, ghPutRaw, ghPutFile, loadJson, saveJson };
