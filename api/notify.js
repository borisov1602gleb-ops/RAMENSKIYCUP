// Sends a Telegram message to the captains of the given teams.
// Called from the admin panel when a match is added, rescheduled, or a
// result is posted, so captains don't have to keep checking the site.
//
// Required environment variables (shared with api/telegram.js, api/draw.js):
//   BOT_TOKEN, GH_TOKEN, GH_REPO, GH_BRANCH, ADMIN_SECRET

const { loadJson } = require('../lib/gh');

async function tg(method, body) {
  const token = process.env.BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

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
    const { secret, teamNames, message } = req.body || {};
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!Array.isArray(teamNames) || !teamNames.length || !message) {
      res.status(400).json({ ok: false, error: 'missing teamNames/message' });
      return;
    }
    const list = await loadJson('data/registrations.json', []);
    const targets = list.filter((t) => teamNames.includes(t.name) && t.tgChatId);
    let sent = 0;
    for (const t of targets) {
      await tg('sendMessage', { chat_id: t.tgChatId, text: message });
      sent++;
    }
    res.status(200).json({ ok: true, sent, matched: targets.length, requested: teamNames.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
