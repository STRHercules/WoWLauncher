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
state.pendingAttachments = [];
state.sendAttempt = null;
state.capabilities = null;
state.loading = false;

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
  const base = state.account?.apiBase || state.settings?.accountApi || '';
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
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
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
    unread: group.unread || 0,
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
  await cancelAttachments();
  state.sendAttempt = null;
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
  void cancelAttachments();
  ChatMedia.clear();
  state.active = null;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  renderThreads();
  void emitActiveThread();
}

function renderMessages() {
  ChatMedia.clear();
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
    for (const attachment of message.attachments || []) block.append(ChatMedia.render(attachment));
    if (!message.mine) {
      const report = document.createElement('button'); report.type = 'button'; report.className = 'report-message'; report.textContent = 'Report';
      report.addEventListener('click', () => {
        state.reportMessage = {conversation: state.active.key, messageId: message.id};
        $('#reportReason').value = ''; $('#reportBackdrop').hidden = false; $('#reportReason').focus();
      }); block.append(report);
    }
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
    attachments: message.attachments || [],
    at: Date.parse(message.createdAt) || Date.now()
  };
}

function friendName(username) {
  const friend = state.friends.find((entry) => entry.username.toLowerCase() === String(username).toLowerCase());
  return friend?.displayName || username;
}

async function loadMessages(before) {
  if (!state.active || state.loading) return 0;
  const thread = state.active;
  const key = thread.key;
  state.loading = true;
  try {
    const payload = await api('/api/v2/social/chat/op', { method: 'POST', body: {
      op: 'history', conversation: key, since: before ? 0 : state.since[key] || 0, ...(before ? { before } : {})
    } });
    const normalized = (payload.messages || []).map(normalizeDm);
    const existing = new Map((state.messages[key] || []).map(m => [m.id, m]));
    const incoming = normalized.filter(m => !m.mine && !existing.has(m.id)).length;
    normalized.forEach(m => existing.set(m.id, m));
    state.messages[key] = [...existing.values()].sort((a, b) => a.id - b.id).slice(-1000);
    if (normalized.length && !before) state.since[key] = normalized[normalized.length - 1].id;
    const last = state.messages[key].at(-1);
    if (last) state.preview[key] = last.body;
    if (state.active?.key === key && document.visibilityState === 'visible' && document.hasFocus() && last)
      await api('/api/v2/social/chat/op', { method: 'POST', body: { op: 'read', conversation: key, cursor: Math.min(last.id, state.since[key] || 0) } });
    return incoming;
  } finally { state.loading = false; }
}

async function pollActive() {
  if (!state.active) return;
  try {
    const before = (state.messages[state.active.key] || []).length;
    const incoming = await loadMessages();
    if (incoming && state.active && (state.messages[state.active.key] || []).length > before) {
      playSound(incomingSound);
      renderMessages();
      void flashIfUnfocused();
    }
  } catch (error) {
    $('#chatStatus').textContent = 'Disconnected. Messages will retry when the service returns.';
    console.warn('Chat poll failed', error);
  }
}

async function refreshFeed() {
  const payload = await api('/api/v2/social/heartbeat', { method: 'POST', body: {} });
  if (!payload) return;
  state.friends = payload.friends || [];
  $('#privacyInput').checked = payload.me?.shareCharacterPresence === true;
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
  if ((!body && !state.pendingAttachments.length) || !state.active || $('#sendButton').disabled) return;
  const thread = state.active;
  const attachmentIds = state.pendingAttachments.map(a => a.id);
  const signature = JSON.stringify([thread.key, body, attachmentIds]);
  if (state.sendAttempt?.signature !== signature) state.sendAttempt = { signature, requestId: crypto.randomUUID() };
  $('#sendButton').disabled = true;
  try {
    const payload = await api('/api/v2/social/chat/op', { method: 'POST', body: {
      op: 'send', conversation: thread.key, body, attachments: attachmentIds, requestId: state.sendAttempt.requestId
    } });
    const messages = new Map((state.messages[thread.key] || []).map(m => [m.id, m]));
    messages.set(payload.message.id, normalizeDm(payload.message));
    state.messages[thread.key] = [...messages.values()].sort((a, b) => a.id - b.id);
    state.preview[thread.key] = body;
    state.pendingAttachments = [];
    state.sendAttempt = null;
    renderPendingAttachments();
    input.value = '';
    playSound(outgoingSound);
    renderMessages();
  } catch (error) {
    $('#chatStatus').textContent = String(error);
  } finally { $('#sendButton').disabled = false; }
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

let started = false;

async function startOnce() {
  if (started) return;
  started = true;
  setInterval(() => {
    refreshFeed().catch(() => {});
    refreshGroups().then(renderThreads).catch(() => {});
  }, 15000);
  if (window.__TAURI__?.event?.listen) {
    await window.__TAURI__.event.listen('chat-open', async (event) => {
      const friend = event.payload?.friend;
      await syncAccount();
      await refreshFeed().catch(() => {});
      if (friend) await openThread(dmKey(friend));
    });
  }
  window.addEventListener('focus', () => {
    void syncAccount();
    void consumePendingChat();
    refreshFeed().catch(() => {});
    if (state.active) void loadMessages().then(renderMessages).catch(() => {});
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void consumePendingChat();
  });
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
  state.settings = await invokeTauri('get_settings').catch(() => null);
  await startOnce();
  if (!state.account) {
    $('#emptyState').hidden = false;
    $('#emptyState').textContent = 'Sign in to your Esteria account in the launcher to chat.';
    return;
  }
  $('#emptyState').hidden = true;
  $('#chatStatus').textContent = `Signed in as ${state.account.username}`;
  try {
    await refreshCapabilities();
    await Promise.all([refreshFeed(), refreshGroups()]);
    await Promise.all(state.friends.map(async (friend) => {
      const key = dmKey(friend.username);
      if (!state.messages[key]) state.messages[key] = [];
      state.preview[key] = friend.statusMessage || '';
    }));
    renderThreads();
  } catch (error) {
    $('#chatStatus').textContent = String(error);
  }
  await consumePendingChat();
}

/** The popout is created at launcher start, so pick up sign-ins/outs that happen afterwards. */
async function syncAccount() {
  const social = await invokeTauri('get_social_state');
  if ((social?.account?.token || '') !== (state.account?.token || '')) await boot();
}

$('#backButton').addEventListener('click', closeThread);
$('#refreshButton').addEventListener('click', () => {
  void syncAccount();
  refreshFeed().catch(() => {});
  refreshGroups().then(renderThreads).catch(() => {});
  if (state.active) loadMessages().then(renderMessages).catch(() => {});
});
$('#newGroupButton').addEventListener('click', openGroupDialog);
$('#cancelGroupButton').addEventListener('click', () => { $('#groupBackdrop').hidden = true; });
$('#createGroupButton').addEventListener('click', createGroup);
$('#composer').addEventListener('submit', sendMessage);
$('#attachButton').addEventListener('click', () => $('#attachmentInput').click());
$('#attachmentInput').addEventListener('change', uploadAttachments);
$('#autoplayInput').checked = localStorage.getItem('chat-autoplay') !== 'false';
$('#autoplayInput').addEventListener('change', event => ChatMedia.setAutoplay(event.target.checked));
$('#privacyInput').addEventListener('change', async event => {
  try { await api('/api/v2/social/chat/op', {method: 'POST', body: {op: 'privacy', shareCharacterPresence: event.target.checked}}); }
  catch (error) { event.target.checked = false; $('#chatStatus').textContent = String(error); }
});
$('#olderButton').addEventListener('click', async () => {
  const first = state.messages[state.active?.key]?.[0];
  if (!first) return;
  const oldHeight = $('#messageList').scrollHeight;
  try { await loadMessages(first.id); renderMessages(); $('#messageList').scrollTop = $('#messageList').scrollHeight - oldHeight; }
  catch (error) { $('#chatStatus').textContent = String(error); }
});
$('#linkAccountButton').addEventListener('click', () => { $('#linkBackdrop').hidden = false; void refreshLinks(); });
$('#closeLinkButton').addEventListener('click', () => { $('#linkBackdrop').hidden = true; });
$('#createLinkButton').addEventListener('click', async () => {
  try {
    const challenge = await api('/api/v2/social/chat/links/challenge', { method: 'POST', body: {} });
    $('#linkCode').textContent = `/ec link ${challenge.code}\nExpires ${new Date(challenge.expiresAt).toLocaleTimeString()}`;
  } catch (error) { $('#linkInstructions').textContent = String(error); }
});
$('#cancelReportButton').addEventListener('click', () => { $('#reportBackdrop').hidden = true; });
$('#sendReportButton').addEventListener('click', async () => {
  const reason = $('#reportReason').value.trim(); if (!reason || !state.reportMessage) return;
  try {
    await api('/api/v2/social/chat/op', {method: 'POST', body: {op: 'report', ...state.reportMessage, reason}});
    $('#reportBackdrop').hidden = true; $('#chatStatus').textContent = 'Report submitted to the server owner.';
  } catch (error) { $('#chatStatus').textContent = String(error); }
});
$('#groupBackdrop').addEventListener('click', (event) => {
  if (event.target === $('#groupBackdrop')) $('#groupBackdrop').hidden = true;
});

async function refreshCapabilities() {
  state.capabilities = await api('/api/v2/social/chat/capabilities');
  ChatMedia.configure(state.capabilities, apiBase(), () => `Bearer ${state.account.token}`);
  $('#attachButton').hidden = !state.capabilities.features.attachments;
  $('#newGroupButton').hidden = !state.capabilities.features.groups;
  $('#privacyLabel').hidden = !state.capabilities.features.characterPresence;
  document.title = `${state.capabilities.productName} Chat`;
  const brand = state.capabilities.branding;
  for (const [key, variable] of Object.entries({background: '--bg', panel: '--panel', accent: '--accent', text: '--text'}))
    if (/^#[0-9a-f]{6}$/i.test(brand[key])) document.documentElement.style.setProperty(variable, brand[key]);
  if (/^[A-Za-z0-9_.-]+\.(ttf|otf)$/.test(brand.font) && state.font !== brand.font) {
    state.font = brand.font;
    const font = new FontFace('Chat Sans', `url("./assets/chat/${brand.font}")`);
    font.load().then(loaded => document.fonts.add(loaded)).catch(() => {});
  }
}
function renderPendingAttachments() {
  const root = $('#pendingAttachments'); root.replaceChildren();
  for (const attachment of state.pendingAttachments) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${attachment.format.toUpperCase()} · ${Math.ceil(attachment.bytes / 1024)} KiB — Cancel`;
    button.addEventListener('click', async () => {
      try {
        await api(`/api/v2/social/chat/attachments/${attachment.id}`, { method: 'DELETE' });
        state.pendingAttachments = state.pendingAttachments.filter(a => a.id !== attachment.id); renderPendingAttachments();
      } catch (error) { $('#chatStatus').textContent = String(error); }
    }); root.append(button);
  }
}
async function cancelAttachments() {
  const pending = state.pendingAttachments; state.pendingAttachments = []; renderPendingAttachments();
  await Promise.all(pending.map(a => api(`/api/v2/social/chat/attachments/${a.id}`, { method: 'DELETE' }).catch(() => {})));
}
async function uploadAttachments() {
  const files = [...$('#attachmentInput').files]; $('#attachmentInput').value = '';
  if (!state.active || !files.length) return;
  const thread = state.active;
  const limits = state.capabilities?.media;
  if (!limits || !ChatMedia.withinLimits([...state.pendingAttachments.map(a => ({ size: a.bytes, type: `image/${a.format === 'jpg' ? 'jpeg' : a.format}` })), ...files], limits)) {
    $('#chatStatus').textContent = 'Images exceed the server’s type, file count, or upload size limits.'; return;
  }
  $('#sendButton').disabled = true; $('#attachButton').disabled = true;
  try {
    for (const file of files) {
      const response = await fetch(`${apiBase()}/api/v2/social/chat/attachments?conversation=${encodeURIComponent(thread.key)}`, {
        method: 'POST', body: file, headers: { authorization: `Bearer ${state.account.token}`, 'content-type': file.type }, signal: AbortSignal.timeout(30000)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      if (state.active?.key !== thread.key) { await api(`/api/v2/social/chat/attachments/${payload.attachment.id}`, { method: 'DELETE' }); break; }
      state.pendingAttachments.push(payload.attachment); renderPendingAttachments();
    }
  } catch (error) { $('#chatStatus').textContent = `Upload failed: ${error.message}. Select the file again to retry.`; }
  finally { $('#sendButton').disabled = false; $('#attachButton').disabled = false; }
}
async function refreshLinks() {
  try {
    const result = await api('/api/v2/social/chat/links');
    const root = $('#linkedAccounts'); root.replaceChildren();
    if (result.pending) {
      const p = result.pending;
      const confirm = document.createElement('button'); confirm.type = 'button';
      confirm.textContent = `Confirm @${p.username} ↔ ${p.name} (game account ${p.gameId}, ${p.serverId}/${p.realmId})`;
      confirm.addEventListener('click', async () => {
        try { await api('/api/v2/social/chat/links/confirm', { method: 'POST', body: { gameId: p.gameId } }); $('#linkCode').textContent = ''; await refreshLinks(); }
        catch (error) { $('#linkInstructions').textContent = String(error); }
      }); root.append(confirm);
    }
    for (const link of result.links) {
      const unlink = document.createElement('button'); unlink.type = 'button';
      unlink.textContent = `Unlink game account ${link.gameId} (${link.serverId}/${link.realmId})`;
      unlink.addEventListener('click', async () => {
        try { await api(`/api/v2/social/chat/links/${link.id}`, { method: 'DELETE' }); await refreshLinks(); }
        catch (error) { $('#linkInstructions').textContent = String(error); }
      }); root.append(unlink);
    }
  } catch (error) { $('#linkInstructions').textContent = String(error); }
}
setInterval(() => { if (!$('#linkBackdrop').hidden) void refreshLinks(); }, 3000);
setInterval(async () => {
  if (!state.account) return;
  try {
    await refreshCapabilities();
    const ids = ChatMedia.ids();
    if (ids.length) ChatMedia.update((await api('/api/v2/social/chat/op', { method: 'POST', body: { op: 'attachmentMetadata', ids } })).attachments);
  } catch (error) { $('#chatStatus').textContent = 'Disconnected; media authorization could not be refreshed.'; ChatMedia.clear(); }
}, 30000);
window.addEventListener('beforeunload', () => ChatMedia.clear());
boot().catch(error => { $('#chatStatus').textContent = String(error); });
