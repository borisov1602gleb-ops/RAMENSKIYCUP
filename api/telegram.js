// Telegram bot webhook for Ramenskiy Cup team registration.
// Runs as a Vercel serverless function. Uses the GitHub repo itself as storage
// (via the Contents API) instead of a database — no extra services required.
//
// Required environment variables (set in the Vercel project settings):
//   BOT_TOKEN      - token from @BotFather
//   GH_TOKEN       - GitHub token with contents read/write on the repo
//   GH_REPO        - "owner/repo", e.g. borisov1602gleb-ops/RAMENSKIYCUP
//   GH_BRANCH      - branch to commit to, e.g. main (default: main)
//   SECRET_TOKEN   - optional, must match Telegram's secret_token header if set

const DEFAULT_MAX_TEAMS = 16;

const POSITIONS = {
  GK: 'GK', ВРТ: 'GK', ВР: 'GK', ГК: 'GK',
  DEF: 'DEF', ЗАЩ: 'DEF', ЗЩ: 'DEF',
  MID: 'MID', ПЗ: 'MID', ПОЛ: 'MID',
  FWD: 'FWD', НАП: 'FWD', НП: 'FWD',
};
const REQUIRED_COUNTS = { GK: 1, DEF: 3, MID: 3, FWD: 1 };

const { env, ghGetFile, ghPutRaw, ghPutFile, loadJson, saveJson } = require('../lib/gh');

async function tg(method, body) {
  const token = process.env.BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function ghUploadLogo(path, buffer, message) {
  const { sha } = await ghGetFile(path);
  return ghPutRaw(path, buffer.toString('base64'), sha, message);
}

async function tgDownloadPhoto(fileId) {
  const token = process.env.BOT_TOKEN;
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('getFile failed: ' + JSON.stringify(info));
  const filePath = info.result.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!r.ok) throw new Error('file download failed: ' + r.status);
  const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, ext };
}

async function getMaxTeams() {
  const cfg = await loadJson('data/bot-config.json', { maxTeams: DEFAULT_MAX_TEAMS });
  return cfg.maxTeams || DEFAULT_MAX_TEAMS;
}

function parseRoster(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 8) return { error: `Нужно ровно 8 строк (по одному игроку), а получено ${lines.length}.` };
  const roster = [];
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const line of lines) {
    const tokens = line.replace(/^\d+[.)]\s*/, (m) => m).trim().split(/\s+/);
    if (tokens.length < 3) return { error: `Не могу разобрать строку: "${line}". Формат: Номер Имя Фамилия Позиция.` };
    const number = tokens[0].replace(/\D/g, '');
    const posRaw = tokens[tokens.length - 1].toUpperCase();
    const pos = POSITIONS[posRaw];
    if (!number || !pos) return { error: `Не могу разобрать строку: "${line}". Позиция должна быть GK/DEF/MID/FWD.` };
    const name = tokens.slice(1, -1).join(' ');
    roster.push([Number(number), name, pos]);
    counts[pos]++;
  }
  for (const p of Object.keys(REQUIRED_COUNTS)) {
    if (counts[p] !== REQUIRED_COUNTS[p]) {
      return { error: `Неверный состав: нужно GK-1, DEF-3, MID-3, FWD-1. Сейчас: GK-${counts.GK}, DEF-${counts.DEF}, MID-${counts.MID}, FWD-${counts.FWD}.` };
    }
  }
  return { roster };
}

const STEP_PROMPTS = {
  name: 'Как называется ваша команда?',
  captain: 'ФИО капитана?',
  phone: 'Телефон для связи?',
  city: 'Город / район?',
  roster: [
    'Пришлите полный состав ОДНИМ сообщением, по одному игроку на строке, в формате:',
    'Номер Имя Фамилия Позиция',
    '',
    'Позиции: GK (вратарь), DEF (защитник), MID (полузащитник), FWD (нападающий).',
    'Нужно ровно 8 игроков: 1 GK, 3 DEF, 3 MID, 1 FWD. Пример:',
    '1 Иван Петров GK',
    '5 Семён Сидоров DEF',
    '6 Кузьма Кузнецов DEF',
    '7 Егор Смирнов DEF',
    '8 Павел Попов MID',
    '9 Влад Волков MID',
    '10 Олег Соколов MID',
    '11 Мороз Морозов FWD',
  ].join('\n'),
  logo: 'Хотите добавить логотип команды? Пришлите фото прямо сюда, или напишите «пропустить».',
};
const STEP_ORDER = ['name', 'captain', 'phone', 'city', 'roster', 'logo'];

function nextStep(step) {
  const i = STEP_ORDER.indexOf(step);
  return STEP_ORDER[i + 1];
}

const BTN = {
  register: '📝 Подать заявку',
  myApp: '📄 Моя заявка',
  myTeam: '🏟 Моя команда',
  groups: '📅 Группы и расписание',
  pending: '📋 Заявки на рассмотрении',
  teams: '✅ Список команд',
  limit: '🎲 Лимит команд',
  broadcast: '📢 Разослать всем капитанам',
  clear: '🗑 Очистить всё (новый турнир)',
};

function menuKeyboard(isAdmin) {
  const rows = [[{ text: BTN.register }, { text: BTN.myApp }], [{ text: BTN.myTeam }, { text: BTN.groups }]];
  if (isAdmin) {
    rows.push([{ text: BTN.pending }, { text: BTN.teams }]);
    rows.push([{ text: BTN.limit }, { text: BTN.broadcast }]);
    rows.push([{ text: BTN.clear }]);
  }
  return { keyboard: rows, resize_keyboard: true };
}

function parseScore(sc) {
  if (!sc) return null;
  const p = String(sc).split(':').map((s) => parseInt(s.trim(), 10));
  return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]) ? p : null;
}

// Считает место команды в группе, ближайший несыгранный матч и бомбардиров
// команды из data/matches.json (публикуется админом с сайта одной кнопкой).
function computeTeamSummary(matchesData, teamName, group) {
  const gm = (matchesData.groupMatches && matchesData.groupMatches[group]) || [];
  const rows = {};
  const touch = (n) => {
    if (!rows[n]) rows[n] = { n, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
    return rows[n];
  };
  gm.forEach((m) => {
    touch(m.a);
    touch(m.b);
    const s = parseScore(m.sc);
    if (!s) return;
    const A = rows[m.a], B = rows[m.b];
    A.gf += s[0]; A.ga += s[1]; B.gf += s[1]; B.ga += s[0];
    if (s[0] > s[1]) { A.w++; A.p += 3; B.l++; }
    else if (s[0] < s[1]) { B.w++; B.p += 3; A.l++; }
    else { A.d++; B.d++; A.p++; B.p++; }
  });
  const standings = Object.values(rows).sort((x, y) => y.p - x.p || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
  const position = standings.findIndex((r) => r.n === teamName) + 1;
  const nextMatch = gm.find((m) => (m.a === teamName || m.b === teamName) && !m.sc && !m.live);
  const scorers = {};
  gm.forEach((m) => {
    (m.events || []).forEach((e) => {
      if (e.type !== 'goal') return;
      const t = e.team === 'a' ? m.a : m.b;
      if (t !== teamName) return;
      scorers[e.player] = (scorers[e.player] || 0) + 1;
    });
  });
  const scorersList = Object.entries(scorers).sort((a, b) => b[1] - a[1]);
  return { position, total: standings.length, nextMatch, scorersList, row: rows[teamName] };
}

async function showMyTeam(chatId) {
  const approved = await loadJson('data/registrations.json', []);
  const team = approved.find((t) => t.tgChatId === chatId);
  if (!team) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Команда не найдена. Эта кнопка доступна капитану, который сам регистрировал команду в этом боте.',
    });
    return;
  }
  if (!team.group) {
    await tg('sendMessage', { chat_id: chatId, text: `Команда «${team.name}» пока не распределена по группам — ждём жеребьёвку.` });
    return;
  }
  const matchesData = await loadJson('data/matches.json', { groupMatches: {}, bracket: [], playoffMatches: [] });
  const s = computeTeamSummary(matchesData, team.name, team.group);
  const lines = [`🏟 Команда «${team.name}» · Группа ${team.group}`];
  if (s.row) {
    lines.push(`Место в группе: ${s.position} из ${s.total} · В${s.row.w}-Н${s.row.d}-П${s.row.l} · Мячи ${s.row.gf}:${s.row.ga} · ${s.row.p} очков`);
  }
  lines.push(s.nextMatch
    ? `Следующий матч: ${s.nextMatch.a} — ${s.nextMatch.b}, ${s.nextMatch.d || 'дата уточняется'} ${s.nextMatch.t || ''}`.trim()
    : 'Следующий матч пока не назначен.');
  if (s.scorersList.length) {
    lines.push('Бомбардиры команды: ' + s.scorersList.map(([n, g]) => `${n} (${g})`).join(', '));
  }
  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
}

async function isAdminChat(chatId) {
  const admin = await loadJson('data/admin.json', null);
  return !!(admin && admin.chatId === chatId);
}

async function beginRegistration(chatId) {
  const [approvedNow, pendingNow, max] = await Promise.all([
    loadJson('data/registrations.json', []),
    loadJson('data/registrations-pending.json', []),
    getMaxTeams(),
  ]);
  if (approvedNow.length + pendingNow.length >= max) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `К сожалению, все ${max} мест на турнир уже заняты. Регистрация закрыта — следите за новостями, места могут появиться позже.`,
    });
    return;
  }
  await saveJson(`data/bot-state.json`, await withState(chatId, { step: 'name', data: {} }), 'bot: start registration');
  await tg('sendMessage', { chat_id: chatId, text: STEP_PROMPTS.name });
}

async function showLimitInfo(chatId) {
  const cur = await getMaxTeams();
  await tg('sendMessage', { chat_id: chatId, text: `Текущий лимит команд: ${cur}. Чтобы изменить, напишите, например: /limit 20` });
}

async function showTeamsList(chatId) {
  const approved = await loadJson('data/registrations.json', []);
  if (!approved.length) {
    await tg('sendMessage', { chat_id: chatId, text: 'Пока нет подтверждённых команд.' });
    return;
  }
  const list = approved.map((t, i) => `${i + 1}. ${t.name} (капитан: ${t.captain})`).join('\n');
  await tg('sendMessage', { chat_id: chatId, text: `Подтверждённые команды (${approved.length}):\n\n${list}\n\nЧтобы удалить команду, напишите: /remove <номер>` });
}

async function showPending(chatId) {
  const pending = await loadJson('data/registrations-pending.json', []);
  if (!pending.length) {
    await tg('sendMessage', { chat_id: chatId, text: 'Нет заявок на рассмотрении.' });
    return;
  }
  for (const app of pending) await sendAppToAdmin(app, chatId);
}

async function showGroups(chatId) {
  const approved = await loadJson('data/registrations.json', []);
  const grouped = approved.filter((t) => t.group);
  if (!grouped.length) {
    await tg('sendMessage', { chat_id: chatId, text: 'Жеребьёвка ещё не проведена — группы появятся здесь сразу после неё.' });
    return;
  }
  const byGroup = {};
  grouped.forEach((t) => {
    (byGroup[t.group] = byGroup[t.group] || []).push(t.name);
  });
  const letters = Object.keys(byGroup).sort();
  const text = letters.map((L) => `Группа ${L}:\n${byGroup[L].map((n, i) => `${i + 1}. ${n}`).join('\n')}`).join('\n\n');
  await tg('sendMessage', { chat_id: chatId, text: `📅 Группы турнира:\n\n${text}\n\nРасписание и результаты матчей — на сайте.` });
}

async function showMyApplication(chatId) {
  const state = await loadJson('data/bot-state.json', {});
  if (state[chatId] && state[chatId].step !== 'broadcast_compose') {
    await tg('sendMessage', { chat_id: chatId, text: `Вы сейчас заполняете заявку (шаг «${state[chatId].step}»). Продолжайте отвечать на вопросы, либо отправьте /start заново.` });
    return;
  }
  const approved = await loadJson('data/registrations.json', []);
  const mine = approved.find((t) => t.tgChatId === chatId);
  if (mine) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Команда «${mine.name}» одобрена!${mine.group ? ` Группа: ${mine.group}.` : ' Жеребьёвка ещё не проведена.'}`,
    });
    return;
  }
  const pending = await loadJson('data/registrations-pending.json', []);
  const minePending = pending.find((t) => t.tgChatId === chatId);
  if (minePending) {
    await tg('sendMessage', { chat_id: chatId, text: `⏳ Заявка команды «${minePending.name}» на рассмотрении у организатора.` });
    return;
  }
  await tg('sendMessage', { chat_id: chatId, text: 'Заявок не найдено. Нажмите «📝 Подать заявку», чтобы зарегистрировать команду.' });
}

async function askClearAll(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: '⚠️ Это удалит ВСЕ подтверждённые команды и все заявки на рассмотрении с сайта — используется перед началом нового турнира. Отменить нельзя. Точно очистить всё?',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Да, очистить всё', callback_data: 'clearall:yes' },
        { text: '❌ Отмена', callback_data: 'clearall:no' },
      ]],
    },
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start') {
    const admin = await isAdminChat(chatId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: [
        '👋 Добро пожаловать в бот регистрации Раменского Кубка Чемпионов!',
        '',
        'Здесь капитаны подают заявки на участие своей команды в турнире 8×8.',
        admin ? 'Вы — администратор, ниже есть кнопки для управления заявками.' : 'Нажмите кнопку ниже, чтобы подать заявку.',
      ].join('\n'),
      reply_markup: menuKeyboard(admin),
    });
    return;
  }

  if (text === BTN.register) {
    await beginRegistration(chatId);
    return;
  }

  if (text === BTN.myApp) {
    await showMyApplication(chatId);
    return;
  }

  if (text === BTN.groups) {
    await showGroups(chatId);
    return;
  }

  if (text === BTN.myTeam) {
    await showMyTeam(chatId);
    return;
  }

  if (text.startsWith('/admin')) {
    const admin = await loadJson('data/admin.json', null);
    if (admin && admin.chatId !== chatId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Администратор уже зарегистрирован.' });
      return;
    }
    if (admin && admin.chatId === chatId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Вы уже администратор.', reply_markup: menuKeyboard(true) });
      return;
    }
    const setupCode = process.env.ADMIN_SETUP_CODE;
    if (setupCode && text.replace('/admin', '').trim() !== setupCode) {
      await tg('sendMessage', { chat_id: chatId, text: 'Для регистрации администратора укажите код: /admin <код>' });
      return;
    }
    await saveJson('data/admin.json', { chatId }, 'bot: register admin');
    await tg('sendMessage', { chat_id: chatId, text: 'Готово! Теперь заявки команд будут приходить сюда на проверку.', reply_markup: menuKeyboard(true) });
    return;
  }

  if (text === BTN.limit || text.startsWith('/limit')) {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    const n = parseInt(text.replace('/limit', '').trim(), 10);
    if (!n || n < 1) {
      await showLimitInfo(chatId);
      return;
    }
    await saveJson('data/bot-config.json', { maxTeams: n }, `bot: set max teams to ${n}`);
    await tg('sendMessage', { chat_id: chatId, text: `Готово! Теперь максимум ${n} команд.` });
    return;
  }

  if (text === BTN.teams || text === '/teams') {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    await showTeamsList(chatId);
    return;
  }

  if (text.startsWith('/remove')) {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    const arg = text.replace('/remove', '').trim();
    const approved = await loadJson('data/registrations.json', []);
    const idx = /^\d+$/.test(arg) ? Number(arg) - 1 : approved.findIndex((t) => t.id === arg);
    if (idx < 0 || idx >= approved.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не нашёл команду с таким номером. Напишите /teams, чтобы увидеть список с номерами.' });
      return;
    }
    const [removed] = approved.splice(idx, 1);
    await saveJson('data/registrations.json', approved, `bot: remove team ${removed.name}`);
    await tg('sendMessage', { chat_id: chatId, text: `Команда «${removed.name}» удалена из турнира.` });
    await promoteFromWaitlist(chatId);
    return;
  }

  if (text === BTN.pending || text === '/pending') {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    await showPending(chatId);
    return;
  }

  if (text === BTN.clear) {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    await askClearAll(chatId);
    return;
  }

  if (text === BTN.broadcast) {
    if (!(await isAdminChat(chatId))) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    await saveJson('data/bot-state.json', await withState(chatId, { step: 'broadcast_compose', data: {} }), 'bot: admin broadcast compose');
    await tg('sendMessage', { chat_id: chatId, text: 'Напишите текст объявления — он уйдёт всем капитанам подтверждённых команд. Например: «Сегодня в 18:00 первый тур группы A, поле 1».' });
    return;
  }

  const state = await loadJson('data/bot-state.json', {});
  const my = state[chatId];
  if (!my) {
    await tg('sendMessage', { chat_id: chatId, text: 'Отправьте /start, чтобы подать заявку на регистрацию команды.' });
    return;
  }

  if (my.step === 'broadcast_compose') {
    const approved = await loadJson('data/registrations.json', []);
    const targets = approved.filter((t) => t.tgChatId);
    for (const t of targets) {
      await tg('sendMessage', { chat_id: t.tgChatId, text: `📢 ${text}` });
    }
    delete state[chatId];
    await saveJson('data/bot-state.json', state, 'bot: finish broadcast');
    await tg('sendMessage', { chat_id: chatId, text: `Готово! Отправлено ${targets.length} командам.` });
    return;
  }

  if (my.step === 'roster') {
    const parsed = parseRoster(text);
    if (parsed.error) {
      await tg('sendMessage', { chat_id: chatId, text: parsed.error + '\n\n' + STEP_PROMPTS.roster });
      return;
    }
    my.data.roster = parsed.roster;
    my.step = 'logo';
    await saveJson('data/bot-state.json', state, 'bot: registration step');
    await tg('sendMessage', { chat_id: chatId, text: STEP_PROMPTS.logo });
    return;
  }

  if (my.step === 'logo') {
    let logoPath = null;
    if (msg.photo && msg.photo.length) {
      try {
        const best = msg.photo[msg.photo.length - 1];
        const { buffer, ext } = await tgDownloadPhoto(best.file_id);
        logoPath = `data/logos/${chatId}-${Date.now()}.${ext}`;
        await ghUploadLogo(logoPath, buffer, `bot: upload logo for ${my.data.name}`);
      } catch (e) {
        console.error('logo upload failed', e);
        await tg('sendMessage', { chat_id: chatId, text: 'Не получилось загрузить логотип, продолжаем без него.' });
      }
    } else if (text.toLowerCase() !== 'пропустить' && text !== '/skip') {
      await tg('sendMessage', { chat_id: chatId, text: 'Пришлите фото логотипа или напишите «пропустить».' });
      return;
    }

    const [approvedNow, pendingNow, max] = await Promise.all([
      loadJson('data/registrations.json', []),
      loadJson('data/registrations-pending.json', []),
      getMaxTeams(),
    ]);
    if (approvedNow.length + pendingNow.length >= max) {
      delete state[chatId];
      await saveJson('data/bot-state.json', state, 'bot: cancel registration (limit reached)');
      await tg('sendMessage', {
        chat_id: chatId,
        text: `К сожалению, все ${max} мест на турнир уже заняты. Регистрация закрыта — следите за новостями, места могут появиться позже.`,
      });
      return;
    }
    const app = {
      id: `${chatId}-${Date.now()}`,
      name: my.data.name,
      captain: my.data.captain,
      phone: my.data.phone,
      city: my.data.city,
      roster: my.data.roster,
      logo: logoPath,
      tgChatId: chatId,
      tgUser: msg.from ? (msg.from.username ? '@' + msg.from.username : msg.from.first_name) : '',
      submittedAt: new Date().toISOString(),
    };
    pendingNow.push(app);
    await saveJson('data/registrations-pending.json', pendingNow, `bot: new application from ${app.name}`);

    delete state[chatId];
    await saveJson('data/bot-state.json', state, 'bot: finish registration');

    const queueNumber = approvedNow.length + pendingNow.length;
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ Заявка отправлена организатору на проверку. Вы заявка №${queueNumber} из ${max} возможных мест. Мы напишем, как только её рассмотрят!`,
    });

    const admin = await loadJson('data/admin.json', null);
    if (admin) await sendAppToAdmin(app, admin.chatId);
    return;
  }

  my.data[my.step] = text;
  const step2 = nextStep(my.step);
  my.step = step2;
  await saveJson('data/bot-state.json', state, 'bot: registration step');
  await tg('sendMessage', { chat_id: chatId, text: STEP_PROMPTS[step2] });
}

async function approveApplication(app) {
  const approved = await loadJson('data/registrations.json', []);
  const max = await getMaxTeams();
  approved.push({ ...app, approvedAt: new Date().toISOString() });
  await saveJson('data/registrations.json', approved, `bot: approve ${app.name}`);
  await tg('sendMessage', {
    chat_id: app.tgChatId,
    text: `🎉 Заявка команды «${app.name}» одобрена и добавлена на сайт! Вы — команда №${approved.length} из ${max}.`,
  });
  return approved;
}

// Когда освобождается место (команду удалили), автоматически одобряет
// следующую по очереди заявку из листа ожидания — чтобы админ не искал вручную.
async function promoteFromWaitlist(adminChatId) {
  const pending = await loadJson('data/registrations-pending.json', []);
  if (!pending.length) return null;
  const [next] = pending.splice(0, 1);
  await saveJson('data/registrations-pending.json', pending, `bot: auto-promote ${next.name} from waitlist`);
  await approveApplication(next);
  await tg('sendMessage', {
    chat_id: adminChatId,
    text: `📈 Освободилось место — команда «${next.name}» автоматически одобрена из листа ожидания.`,
  });
  return next;
}

async function withState(chatId, entry) {
  const state = await loadJson('data/bot-state.json', {});
  state[chatId] = entry;
  return state;
}

async function sendAppToAdmin(app, adminChatId) {
  const rosterText = app.roster.map((p) => `${p[0]} ${p[1]} (${p[2]})`).join('\n');
  const text = [
    `📋 Новая заявка на регистрацию`,
    `Команда: ${app.name}`,
    `Капитан: ${app.captain}`,
    `Телефон: ${app.phone}`,
    `Город: ${app.city}`,
    `Контакт в Telegram: ${app.tgUser || '—'}`,
    ``,
    `Состав:`,
    rosterText,
  ].join('\n');
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Подтвердить', callback_data: `a:${app.id}` },
        { text: '❌ Отклонить', callback_data: `r:${app.id}` },
      ],
      ...(app.logo ? [[{ text: '🖼 Подтвердить без фото', callback_data: `anp:${app.id}` }]] : []),
    ],
  };
  if (app.logo) {
    const rawUrl = `https://raw.githubusercontent.com/${process.env.GH_REPO}/${env('GH_BRANCH', 'main')}/${app.logo}`;
    await tg('sendPhoto', { chat_id: adminChatId, photo: rawUrl, caption: text, reply_markup: keyboard });
  } else {
    await tg('sendMessage', { chat_id: adminChatId, text, reply_markup: keyboard });
  }
}

async function handleCallback(cb) {
  const admin = await loadJson('data/admin.json', null);
  const chatId = cb.message.chat.id;
  if (!admin || admin.chatId !== chatId) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Недоступно' });
    return;
  }
  if (cb.data.startsWith('clearall:')) {
    if (cb.data === 'clearall:yes') {
      await saveJson('data/registrations.json', [], 'bot: clear all teams (new tournament)');
      await saveJson('data/registrations-pending.json', [], 'bot: clear pending applications (new tournament)');
      await saveJson('data/bot-state.json', {}, 'bot: clear in-progress registrations (new tournament)');
      await tg('editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: '✅ Все команды и заявки удалены. Можно начинать регистрацию на новый турнир.' });
    } else {
      await tg('editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: 'Отменено — данные не тронуты.' });
    }
    await tg('answerCallbackQuery', { callback_query_id: cb.id });
    return;
  }
  const [action, id] = cb.data.split(':');
  const pending = await loadJson('data/registrations-pending.json', []);
  const idx = pending.findIndex((a) => a.id === id);
  if (idx === -1) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Заявка уже обработана' });
    return;
  }
  const [app] = pending.splice(idx, 1);
  await saveJson('data/registrations-pending.json', pending, `bot: resolve application ${app.name}`);

  if (action === 'a' || action === 'anp') {
    await approveApplication(action === 'anp' ? { ...app, logo: null } : app);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: cb.message.text + (action === 'anp' ? '\n\n✅ Одобрено без фото (фото отклонено модерацией)' : '\n\n✅ Одобрено'),
    });
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Одобрено' });
  } else {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: cb.message.text + '\n\n❌ Отклонено',
    });
    await tg('sendMessage', {
      chat_id: app.tgChatId,
      text: `Мы внимательно рассмотрели заявку команды «${app.name}», но, к сожалению, в данный момент не можем взять вас в турнир. Мы считаем вас сильной и перспективной командой — будем рады видеть вас в следующий раз!`,
    });
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отклонено' });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('Ramenskiy Cup registration bot is running.');
    return;
  }
  const secret = process.env.SECRET_TOKEN;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).end();
    return;
  }
  try {
    const update = req.body;
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error(err);
  }
  res.status(200).end();
};
