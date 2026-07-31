// Publishes a group draw result: writes each team's assigned group letter
// into data/registrations.json so it's live for every site visitor immediately
// (no manual chat step needed). Called from the admin panel's draw ceremony.
//
// Required environment variables (shared with api/telegram.js):
//   GH_TOKEN, GH_REPO, GH_BRANCH
//   ADMIN_SECRET - must match the value the admin panel sends (same as the
//                  site's admin login password, kept in one place)

const { loadJson, saveJson } = require('../lib/gh');

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  try {
    const { secret, groups } = req.body || {};
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!groups || typeof groups !== 'object') {
      res.status(400).json({ ok: false, error: 'missing groups' });
      return;
    }
    const idToGroup = {};
    Object.keys(groups).forEach((letter) => {
      (groups[letter] || []).forEach((id) => {
        idToGroup[id] = letter;
      });
    });
    const list = await loadJson('data/registrations.json', []);
    const updated = list.map((t) => ({ ...t, group: idToGroup[t.id] || null }));
    await saveJson('data/registrations.json', updated, 'admin: publish group draw');
    res.status(200).json({ ok: true, count: updated.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
