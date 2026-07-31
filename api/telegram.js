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

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

async function tg(method, body) {
  const token = process.env.BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
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

async function ghPutFile(path, obj, sha, message) {
  const repo = process.env.GH_REPO;
  const branch = env('GH_BRANCH', 'main');
  const body = {
    message,
    content: Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64'),
    branch,
  };
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

async function loadJson(path, fallback) {
  const { json } = await ghGetFile(path);
  return json === null ? fallback : json;
}

async function getMaxTeams() {
  const cfg = await loadJson('data/bot-config.json', { maxTeams: DEFAULT_MAX_TEAMS });
  return cfg.maxTeams || DEFAULT_MAX_TEAMS;
}

async function saveJson(path, obj, message) {
  const { sha } = await ghGetFile(path);
  return ghPutFile(path, obj, sha, message);
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
};
const STEP_ORDER = ['name', 'captain', 'phone', 'city', 'roster'];

function nextStep(step) {
  const i = STEP_ORDER.indexOf(step);
  return STEP_ORDER[i + 1];
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start') {
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
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Добро пожаловать! Начнём регистрацию команды на Раменский Кубок.\n\n' + STEP_PROMPTS.name,
    });
    return;
  }

  if (text === '/admin') {
    const admin = await loadJson('data/admin.json', null);
    if (admin && admin.chatId !== chatId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Администратор уже зарегистрирован.' });
      return;
    }
    await saveJson('data/admin.json', { chatId }, 'bot: register admin');
    await tg('sendMessage', { chat_id: chatId, text: 'Готово! Теперь заявки команд будут приходить сюда на проверку.' });
    return;
  }

  if (text.startsWith('/limit')) {
    const admin = await loadJson('data/admin.json', null);
    if (!admin || admin.chatId !== chatId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    const n = parseInt(text.replace('/limit', '').trim(), 10);
    if (!n || n < 1) {
      const cur = await getMaxTeams();
      await tg('sendMessage', { chat_id: chatId, text: `Текущий лимит команд: ${cur}. Чтобы изменить, напишите, например: /limit 20` });
      return;
    }
    await saveJson('data/bot-config.json', { maxTeams: n }, `bot: set max teams to ${n}`);
    await tg('sendMessage', { chat_id: chatId, text: `Готово! Теперь максимум ${n} команд.` });
    return;
  }

  if (text === '/pending') {
    const admin = await loadJson('data/admin.json', null);
    if (!admin || admin.chatId !== chatId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Эта команда доступна только администратору (отправьте /admin, чтобы им стать).' });
      return;
    }
    const pending = await loadJson('data/registrations-pending.json', []);
    if (!pending.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'Нет заявок на рассмотрении.' });
      return;
    }
    for (const app of pending) await sendAppToAdmin(app, chatId);
    return;
  }

  const state = await loadJson('data/bot-state.json', {});
  const my = state[chatId];
  if (!my) {
    await tg('sendMessage', { chat_id: chatId, text: 'Отправьте /start, чтобы подать заявку на регистрацию команды.' });
    return;
  }

  if (my.step === 'roster') {
    const parsed = parseRoster(text);
    if (parsed.error) {
      await tg('sendMessage', { chat_id: chatId, text: parsed.error + '\n\n' + STEP_PROMPTS.roster });
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
    my.data.roster = parsed.roster;
    const app = {
      id: `${chatId}-${Date.now()}`,
      name: my.data.name,
      captain: my.data.captain,
      phone: my.data.phone,
      city: my.data.city,
      roster: my.data.roster,
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
  await tg('sendMessage', {
    chat_id: adminChatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `a:${app.id}` },
        { text: '❌ Отклонить', callback_data: `r:${app.id}` },
      ]],
    },
  });
}

async function handleCallback(cb) {
  const admin = await loadJson('data/admin.json', null);
  const chatId = cb.message.chat.id;
  if (!admin || admin.chatId !== chatId) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Недоступно' });
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

  if (action === 'a') {
    const approved = await loadJson('data/registrations.json', []);
    const max = await getMaxTeams();
    approved.push({ ...app, approvedAt: new Date().toISOString() });
    await saveJson('data/registrations.json', approved, `bot: approve ${app.name}`);
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: cb.message.text + '\n\n✅ Одобрено',
    });
    await tg('sendMessage', {
      chat_id: app.tgChatId,
      text: `🎉 Заявка команды «${app.name}» одобрена и добавлена на сайт! Вы — команда №${approved.length} из ${max}.`,
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
