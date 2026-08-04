// Publishes group-stage results, match events (goals/cards) and the playoff
// bracket into data/matches.json so they're live for every site visitor
// immediately, and readable by the bot (captain cabinet, disqualification
// warnings). Called from the admin panel's "Опубликовать" button — same
// zero-manual-step pattern as api/draw.js.
//
// Required environment variables (shared with api/telegram.js):
//   BOT_TOKEN, GH_TOKEN, GH_REPO, GH_BRANCH
//   ADMIN_SECRET - must match the secret entered once in the admin panel

const { loadJson, saveJson } = require('../lib/gh');

const DEFAULT_YELLOW_THRESHOLD = 3;

async function tg(method, body) {
  const token = process.env.BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function tallyCards(groupMatches, playoffMatches) {
  const tally = {};
  const all = [...Object.values(groupMatches || {}).flat(), ...(playoffMatches || [])];
  all.forEach((m) => {
    (m.events || []).forEach((e) => {
      if (e.type !== 'yellow' && e.type !== 'red') return;
      const team = e.team === 'a' ? m.a : m.b;
      const key = `${team}|${e.player}`;
      if (!tally[key]) tally[key] = { team, player: e.player, yellow: 0, red: 0 };
      if (e.type === 'yellow') tally[key].yellow++;
      else tally[key].red++;
    });
  });
  return tally;
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
    const { secret, groupMatches, bracket, playoffMatches } = req.body || {};
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    const prev = await loadJson('data/matches.json', { groupMatches: {}, bracket: [], playoffMatches: [] });
    const prevCards = tallyCards(prev.groupMatches, prev.playoffMatches);
    const nextCards = tallyCards(groupMatches, playoffMatches);

    const next = { groupMatches: groupMatches || {}, bracket: bracket || [], playoffMatches: playoffMatches || [] };
    await saveJson('data/matches.json', next, 'admin: publish match results');

    const cfg = await loadJson('data/bot-config.json', {});
    const yellowThreshold = cfg.cardThresholdYellow || DEFAULT_YELLOW_THRESHOLD;
    const teams = await loadJson('data/registrations.json', []);

    let cardsNotified = 0;
    for (const key of Object.keys(nextCards)) {
      const cur = nextCards[key];
      const before = prevCards[key] || { yellow: 0, red: 0 };
      const wasFlagged = before.red > 0 || before.yellow >= yellowThreshold;
      const nowFlagged = cur.red > 0 || cur.yellow >= yellowThreshold;
      if (wasFlagged || !nowFlagged) continue;
      const team = teams.find((t) => t.name === cur.team);
      if (!team || !team.tgChatId) continue;
      const reason = cur.red > 0 ? 'красная карточка' : `${cur.yellow}-я жёлтая карточка`;
      try {
        await tg('sendMessage', {
          chat_id: team.tgChatId,
          text: `🟥 Внимание! У игрока ${cur.player} (${cur.team}) — ${reason}. Пропуск следующего матча по регламенту.`,
        });
        cardsNotified++;
      } catch (e) {
        console.error('card notify failed for', key, e);
      }
    }

    res.status(200).json({ ok: true, cardsNotified });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
