// Scheduled job (Vercel Cron, see vercel.json) that:
//  1) reminds both teams' captains about an upcoming match — once when it's
//     within 24h out, once when it's within 1h out;
//  2) pings the admin if a match's scheduled time has passed by 3+ hours
//     and no score has been entered yet.
// Needs a match to have a structured `dt` (ISO datetime, set via the
// datetime-local field in the results editor) — matches with only free-text
// date/time are skipped, since there's nothing reliable to schedule against.
//
// Idempotent: data/reminder-log.json remembers which (matchId, kind) pairs
// were already sent, so re-running the cron never double-notifies.

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

function allMatches(matchesData) {
  const groupMatches = Object.entries(matchesData.groupMatches || {}).flatMap(([L, ms]) =>
    ms.map((m) => ({ ...m, _group: L }))
  );
  const playoff = (matchesData.playoffMatches || []).map((m) => ({ ...m, _group: null }));
  return [...groupMatches, ...playoff];
}

module.exports = async (req, res) => {
  try {
    const [matchesData, teams, log] = await Promise.all([
      loadJson('data/matches.json', { groupMatches: {}, bracket: [], playoffMatches: [] }),
      loadJson('data/registrations.json', []),
      loadJson('data/reminder-log.json', {}),
    ]);
    const admin = await loadJson('data/admin.json', null);
    const now = Date.now();
    const byName = {};
    teams.forEach((t) => { byName[t.name] = t; });

    let changed = false;
    const mark = (key) => { log[key] = true; changed = true; };
    const already = (key) => !!log[key];

    for (const m of allMatches(matchesData)) {
      if (!m.dt || !m.id) continue;
      const kickoff = new Date(m.dt).getTime();
      if (isNaN(kickoff)) continue;
      const hoursUntil = (kickoff - now) / 3600000;
      const teamA = byName[m.a], teamB = byName[m.b];

      if (!m.sc && hoursUntil <= 24 && hoursUntil > -1 && !already(`${m.id}:day`)) {
        for (const t of [teamA, teamB]) {
          if (t && t.tgChatId) {
            await tg('sendMessage', {
              chat_id: t.tgChatId,
              text: `📅 Напоминание: завтра/скоро у вашей команды матч с «${t === teamA ? m.b : m.a}» — ${m.d || ''} ${m.t || ''}${m.f ? `, ${m.f}` : ''}.`,
            });
          }
        }
        mark(`${m.id}:day`);
      }

      if (!m.sc && hoursUntil <= 1 && hoursUntil > -0.5 && !already(`${m.id}:hour`)) {
        for (const t of [teamA, teamB]) {
          if (t && t.tgChatId) {
            await tg('sendMessage', {
              chat_id: t.tgChatId,
              text: `⏰ Через час матч: «${m.a}» — «${m.b}»${m.f ? `, ${m.f}` : ''}. Удачи!`,
            });
          }
        }
        mark(`${m.id}:hour`);
      }

      if (!m.sc && hoursUntil <= -3 && admin && !already(`${m.id}:unfilled`)) {
        await tg('sendMessage', {
          chat_id: admin.chatId,
          text: `⚠️ Матч «${m.a}» — «${m.b}» (${m.d || ''} ${m.t || ''}) должен был закончиться, но счёт не внесён. Не забудьте заполнить результат в админке.`,
        });
        mark(`${m.id}:unfilled`);
      }
    }

    if (changed) await saveJson('data/reminder-log.json', log, 'cron: reminder log update');
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
};
