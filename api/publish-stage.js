// Publishes which stage of the site (registration / group / playoff / final /
// maintenance) every visitor sees, writing to data/site-stage.json — the same
// zero-manual-step pattern as draw/results publishing, so switching stages
// in the admin panel takes effect for everyone immediately instead of only
// in the admin's own browser.

const { loadJson, saveJson } = require('../lib/gh');

const VALID_STAGES = ['maintenance', 'registration', 'group', 'playoff', 'final'];

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
    const { secret, stage } = req.body || {};
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!VALID_STAGES.includes(stage)) {
      res.status(400).json({ ok: false, error: 'invalid stage' });
      return;
    }
    await saveJson('data/site-stage.json', { stage, publishedAt: new Date().toISOString() }, `admin: publish stage ${stage}`);
    res.status(200).json({ ok: true, stage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
