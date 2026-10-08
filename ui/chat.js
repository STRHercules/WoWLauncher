const $ = (selector) => document.querySelector(selector);

const state = {
  account: null,
  profile: null,
  friends: [],
  groups: [],
  active: null,
  messages: {},
  since: {},
  unread: {},
  preview: {},
  lastUnreadTotal: 0,
  timer: null
};

const incomingSound = new Audio('./assets/audio/incoming.mp3');
const outgoingSound = new Audio('./assets/audio/outgoing.mp3');
incomingSound.volume = 0.7;
outgoingSound.volume = 0.55;

async function currentHandle() {
  const api = window.__TAURI__?.window;
  if (!api) return null;
  try {
    if (typeof api.getCurrentWindow === 'function') return await api.getCurrentWindow();
    if (api.Window && typeof api.Window.getCurrent === 'function') return await api.Window.getCurrent();
  } catch (error) {
    console.warn('Could not resolve this chat window', error);
  }
  return null;
}

async function flashIfUnfocused() {
  const handle = await currentHandle();
  if (!handle) return;
  try {
    if (await handle.isFocused()) return;
    await handle.requestUserAttention(2);
  } catch (error) {
    console.warn('Could not flash the chat window', error);
  }
}

/** Opens whichever conversation the launcher asked for, even if the event was missed. */
async function consumePendingChat() {
  const friend = await invokeTauri('take_pending_chat');
  if (!friend) return false;
  await refreshFeed().catch(() => {});
  await openThread(dmKey(friend));
  return true;
}

async function emitActiveThread() {
  if (!window.__TAURI__?.event?.emit) return;
  try {
    await window.__TAURI__.event.emit('chat-thread', { friend: state.active?.username || '' });
  } catch (error) {
    console.warn('Could not report the active chat', error);
  }
}

function playSound(audio) {
  // The thread poll and the feed poll can both spot the same message; keep one sound.
  if (Date.now() - (playSound.last || 0) < 1200) return;
  playSound.last = Date.now();
  try {
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  } catch (error) {
    console.warn('Could not play chat sound', error);
  }
}

async function invokeTauri(command, args = {}) {
  if (!window.__TAURI__?.core?.invoke) return null;
  return window.__TAURI__.core.invoke(command, args);
}

function apiBase() {
  const base = state.account?.apiBase || state.profile?.apiBase || '';
  return String(base).trim().replace(/\/+$/, '');
}

function absUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${apiBase()}${url}`;
}

async function api(path, { method = 'GET', body } = {}) {
  const base = apiBase();
  if (!base) throw new Error('The Esteria account API address is not set.');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(state.account?.token ? { authorization: `Bearer ${state.account.token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Chat request failed (${response.status}).`);
  return payload;
}

const dmKey = (username) => `dm:${String(username).toLowerCase()}`;
const groupKey = (id) => `group:${id}`;

function threadList() {
  const friends = state.friends.map((friend) => ({
    key: dmKey(friend.username),
    kind: 'dm',
    id: friend.username,
    name: friend.displayName || friend.username,
    username: friend.username,
    avatarUrl: absUrl(friend.avatarUrl),
    presence: friend.presence,
    unread: state.unread[dmKey(friend.username)] || 0,
    preview: state.preview[dmKey(friend.username)] || friend.statusMessage || ''
  }));
  const groups = state.groups.map((group) => ({
    key: groupKey(group.id),
    kind: 'group',
    id: group.id,
    name: group.name,
    username: '',
    avatarUrl: '',
    presence: 'online',
    unread: state.unread[groupKey(group.id)] || 0,
    preview: state.preview[groupKey(group.id)] || `${group.members.length} members`
  }));
  return [...groups, ...friends];
}

function applyAvatar(element, url, initials) {
  element.replaceChildren();
  if (!url) {
    element.textContent = initials;
    return;
  }
  const image = document.createElement('img');
  image.src = url;
  image.alt = '';
  image.addEventListener('error', () => {
    element.replaceChildren();
    element.textContent = initials;
  });
  element.append(image);
}

function renderThreads() {
  const list = $('#threadList');
  const conversation = $('#conversation');
  const showList = !state.active;
  list.hidden = !showList;
  conversation.hidden = showList;
  $('#backButton').hidden = showList;
  $('#chatHeading').textContent = state.active ? state.active.name : 'Chats';
  $('#chatStatus').textContent = state.active
    ? state.active.kind === 'group'
      ? `${state.active.members} members`
      : presenceLabel(state.active.presence)
    : `${state.friends.length} friends · ${state.groups.length} groups`;
  if (!showList) return;

  list.replaceChildren();
  const entries = threadList();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Add a friend in the launcher to start chatting.';
    list.append(empty);
    return;
  }

  const groups = entries.filter((entry) => entry.kind === 'group');
  const friends = entries.filter((entry) => entry.kind !== 'group');
  const appendSection = (label, items) => {
    if (!items.length) return;
    const heading = document.createElement('div');
    heading.className = 'section-label';
    heading.textContent = label;
    list.append(heading);
    items.forEach((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'thread';
      const avatar = document.createElement('span');
      avatar.className = `thread-avatar${entry.kind === 'group' ? ' is-group' : ''}`;
      applyAvatar(avatar, entry.avatarUrl, entry.name.slice(0, 2).toUpperCase());
      const copy = document.createElement('span');
      copy.className = 'thread-copy';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const preview = document.createElement('small');
      preview.textContent = entry.preview || 'No messages yet';
      copy.append(name, preview);
      const meta = document.createElement('span');
      meta.className = 'thread-meta';
      if (entry.unread) {
        const badge = document.createElement('span');
        badge.className = 'unread';
        badge.textContent = String(entry.unread);
        meta.append(badge);
      } else if (entry.kind !== 'group') {
        const dot = document.createElement('span');
        dot.className = `dot ${presenceClass(entry.presence)}`;
        meta.append(dot);
      }
      row.append(avatar, copy, meta);
      row.addEventListener('click', () => openThread(entry.key));
      list.append(row);
    });
  };
  appendSection('Groups', groups);
  appendSection('Friends', friends);
}

function presenceClass(value) {
  const presence = String(value || '').toLowerCase();
  return ['online', 'away', 'dnd', 'offline'].includes(presence) ? presence : 'offline';
}

function presenceLabel(value) {
  return { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline' }[presenceClass(value)];
}

function findThread(key) {
  return threadList().find((entry) => entry.key === key) || null;
}

async function openThread(key) {
  const thread = findThread(key);
  if (!thread) return;
  state.active = thread;
  state.unread[key] = 0;
  renderThreads();
  void emitActiveThread();
  await loadMessages();
  renderMessages();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(pollActive, 5000);
  $('#messageInput').focus();
}

function closeThread() {
  state.active = null;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  renderThreads();
  void emitActiveThread();
}

function renderMessages() {
  const list = $('#messageList');
  list.replaceChildren();
  const key = state.active?.key;
  const messages = (key && state.messages[key]) || [];
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No messages with ${state.active?.name || 'this chat'} yet.`;
    list.append(empty);
    return;
  }
  messages.forEach((message) => {
    const block = document.createElement('div');
    block.className = 'message';
    if (message.mine) block.classList.add('is-mine');
    const body = document.createElement('p');
    body.textContent = message.body;
    const meta = document.createElement('small');
    meta.textContent = `${message.mine ? 'You' : message.from} · ${new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    block.append(body, meta);
    list.append(block);
  });
  list.scrollTop = list.scrollHeight;
}

function normalizeDm(message) {
  return {
    id: message.id,
    from: message.from === state.account?.username ? 'You' : friendName(message.from),
    mine: message.from === state.account?.username,
    body: message.body,
    at: Date.parse(message.createdAt) || Date.now()
  };
}

function friendName(username) {
  const friend = state.friends.find((entry) => entry.username.toLowerCase() === String(username).toLowerCase());
  return friend?.displayName || username;
}

async function loadMessages() {
  if (!state.active) return;
  const key = state.active.key;
  const since = state.since[key] || 0;
  let incoming = 0;
  if (state.active.kind === 'group') {
    const payload = await api(`/api/v2/social/groups/${state.active.id}/messages?since=${since}`);
    const normalized = (payload?.messages || []).map((message) => ({
      id: message.id,
      from: friendName(message.from),
      mine: message.from === state.account?.username,
      body: message.body,
      at: Date.parse(message.createdAt) || Date.now()
    }));
    incoming = normalized.filter((message) => !message.mine).length;
    state.messages[key] = [...(state.messages[key] || []), ...normalized];
  } else {
    const payload = await api(`/api/v2/social/messages?with=${encodeURIComponent(state.active.username)}&since=${since}`);
    const normalized = (payload?.messages || []).map(normalizeDm);
    incoming = normalized.filter((message) => !message.mine).length;
    state.messages[key] = [...(state.messages[key] || []), ...normalized];
  }
  const all = state.messages[key] || [];
  if (all.length) {
    state.since[key] = all[all.length - 1].id;
    state.preview[key] = all[all.length - 1].body;
  }
  return incoming;
}

async function pollActive() {
  if (!state.active) return;
  try {
    const before = (state.messages[state.active.key] || []).length;
    const incoming = await loadMessages();
    if (incoming && (state.messages[state.active.key] || []).length > before) {
      playSound(incomingSound);
      renderMessages();
      void flashIfUnfocused();
    }
  } catch (error) {
    console.warn('Chat poll failed', error);
  }
}

async function refreshFeed() {
  const payload = await api('/api/v2/social/heartbeat', { method: 'POST', body: {} });
  if (!payload) return;
  state.friends = payload.friends || [];
  const total = Number(payload.unread) || 0;
  if (state.seeded && total > state.lastUnreadTotal) {
    playSound(incomingSound);
    void flashIfUnfocused();
  }
  state.lastUnreadTotal = total;
  state.seeded = true;
  state.friends.forEach((friend) => {
    const key = dmKey(friend.username);
    state.unread[key] = Number(friend.unread) || 0;
  });
  renderThreads();
}

async function refreshGroups() {
  const payload = await api('/api/v2/social/groups');
  state.groups = payload?.groups || [];
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $('#messageInput');
  const body = input.value.trim();
  if (!body || !state.active) return;
  try {
    if (state.active.kind === 'group') {
      const payload = await api(`/api/v2/social/groups/${state.active.id}/messages`, { method: 'POST', body: { body } });
      state.messages[state.active.key] = [...(state.messages[state.active.key] || []), {
        id: payload.message.id,
        from: 'You',
        mine: true,
        body: payload.message.body,
        at: Date.parse(payload.message.createdAt) || Date.now()
      }];
    } else {
      const payload = await api('/api/v2/social/messages', {
        method: 'POST',
        body: { to: state.active.username, body }
      });
      state.messages[state.active.key] = [...(state.messages[state.active.key] || []), normalizeDm(payload.message)];
    }
    const all = state.messages[state.active.key];
    state.since[state.active.key] = all[all.length - 1].id;
    state.preview[state.active.key] = body;
    input.value = '';
    playSound(outgoingSound);
    renderMessages();
  } catch (error) {
    $('#chatStatus').textContent = String(error);
  }
}

function openGroupDialog() {
  const container = $('#groupFriendList');
  container.replaceChildren();
  if (!state.friends.length) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Add friends first, then you can group them.';
    container.append(note);
  }
  state.friends.forEach((friend) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = friend.username;
    const name = document.createElement('span');
    name.textContent = friend.displayName || friend.username;
    label.append(input, name);
    container.append(label);
  });
  $('#groupNameInput').value = '';
  $('#groupBackdrop').hidden = false;
  $('#groupNameInput').focus();
}

async function createGroup() {
  const members = [...$('#groupFriendList').querySelectorAll('input:checked')].map((input) => input.value);
  try {
    const payload = await api('/api/v2/social/groups', {
      method: 'POST',
      body: { name: $('#groupNameInput').value.trim(), members }
    });
    $('#groupBackdrop').hidden = true;
    await refreshGroups();
    renderThreads();
    if (payload?.group) await openThread(groupKey(payload.group.id));
  } catch (error) {
    $('#chatStatus').textContent = String(error);
  }
}

async function boot() {
  const social = await invokeTauri('get_social_state');
  if (!social) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Run the launcher in the desktop app to use chat.';
    return;
  }
  state.profile = social.profile || {};
  state.account = social.account || null;
  if (!state.account) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Sign in to your Esteria account in the launcher to chat.';
    return;
  }
  $('#chatStatus').textContent = `Signed in as ${state.account.username}`;
  try {
    await Promise.all([refreshFeed(), refreshGroups()]);
    await Promise.all(state.friends.map(async (friend) => {
      const key = dmKey(friend.username);
      if (!state.messages[key]) state.messages[key] = [];
      state.preview[key] = friend.statusMessage || '';
    }));
    renderThreads();
    setInterval(() => {
      refreshFeed().catch(() => {});
      refreshGroups().then(renderThreads).catch(() => {});
    }, 15000);
  } catch (error) {
    $('#chatStatus').textContent = String(error);
  }
  await consumePendingChat();
  if (window.__TAURI__?.event?.listen) {
    await window.__TAURI__.event.listen('chat-open', async (event) => {
      const friend = event.payload?.friend;
      await refreshFeed().catch(() => {});
      if (friend) await openThread(dmKey(friend));
    });
  }
  window.addEventListener('focus', () => {
    void consumePendingChat();
    refreshFeed().catch(() => {});
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void consumePendingChat();
  });
}

$('#backButton').addEventListener('click', closeThread);
$('#refreshButton').addEventListener('click', () => {
  refreshFeed().catch(() => {});
  refreshGroups().then(renderThreads).catch(() => {});
  if (state.active) loadMessages().then(renderMessages).catch(() => {});
});
$('#newGroupButton').addEventListener('click', openGroupDialog);
$('#cancelGroupButton').addEventListener('click', () => { $('#groupBackdrop').hidden = true; });
$('#createGroupButton').addEventListener('click', createGroup);
$('#composer').addEventListener('submit', sendMessage);
$('#groupBackdrop').addEventListener('click', (event) => {
  if (event.target === $('#groupBackdrop')) $('#groupBackdrop').hidden = true;
});

boot();