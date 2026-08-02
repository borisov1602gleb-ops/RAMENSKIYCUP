// Publishes a group draw result: writes each team's assigned group letter
// into data/registrations.json so it's live for every site visitor immediately
// (no manual chat step needed), then notifies every drawn team's captain via
// the bot. Called from the admin panel's draw ceremony.
//
// Required environment variables (shared with api/telegram.js):
//   BOT_TOKEN, GH_TOKEN, GH_REPO, GH_BRANCH
//   ADMIN_SECRET - must match the secret entered once in the admin panel
//                  (prompted client-side, never shipped in the page source)

const { loadJson, saveJson } = require('../lib/gh');

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

    const byGroup = {};
    updated.forEach((t) => {
      if (t.group) (byGroup[t.group] = byGroup[t.group] || []).push(t.name);
    });
    let notified = 0;
    for (const t of updated) {
      if (!t.group || !t.tgChatId) continue;
      const mates = byGroup[t.group].filter((n) => n !== t.name);
      const text = [
        '🎲 Жеребьёвка проведена!',
        `Ваша команда «${t.name}» — в группе ${t.group}.`,
        mates.length ? `Соперники по группе: ${mates.join(', ')}.` : '',
        'Подробнее — на сайте.',
      ].filter(Boolean).join('\n');
      try {
        await tg('sendMessage', { chat_id: t.tgChatId, text });
        notified++;
      } catch (e) {
        console.error('draw notify failed for', t.id, e);
      }
    }

    res.status(200).json({ ok: true, count: updated.length, notified });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
