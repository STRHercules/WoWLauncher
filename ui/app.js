const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const DEFAULT_SETTINGS = {
  gamePath: '',
  channel: 'live',
  manifestSource: 'http://planetkai.hopto.org:7384/api/v2/client/live/manifest.json',
  addonCatalogSource: 'http://planetkai.hopto.org:7384/api/v2/addons/catalog.json',
  newsSource: 'http://planetkai.hopto.org:7384/api/v2/news.json',
  statusSource: 'http://planetkai.hopto.org:7384/api/v2/status',
  socialSource: 'http://planetkai.hopto.org:7384/api/v2/social.json',
  accountApi: 'http://planetkai.hopto.org:7384',
  gameApi: 'http://planetkai.hopto.org:8095',
  clientSource: '',
  discordPresence: true,
  discordClientId: '',
  armorySource: 'http://planetkai.hopto.org:7384/api/v2/armory/characters.json',
  databaseSource: 'http://planetkai.hopto.org:7384/api/v2/database/index.json',
  autoUpdateAddons: true,
  realmHost: 'planetkai.hopto.org',
  realmPort: 3724,
  patchList: 'planetkai.hopto.org',
  cleanWdb: true,
  closeAction: 'ask',
  playAction: 'ask'
};

const appState = {
  settings: { ...DEFAULT_SETTINGS },
  verification: null,
  needsRepair: false,
  clientInstalled: false,
  updateRunning: false,
  addonBusy: false,
  addons: [],
  runtimeInfo: null,
  serverStatus: null,
  launcherUpdate: null,
  launcherUpdating: false,
  featuredNewsUrl: '',
  showingAddons: false,
  activeView: 'home',
  social: null,
  socialSnapshot: null,
  accountFeed: null,
  accountThreads: {},
  discoverResults: [],
  accountBusy: false,
  chatWindowOpen: false,
  chatWindowShown: false,
  chatThread: '',
  unreadTotal: null,
  unreadByFriend: {},
  posts: [],
  postMedia: null,
  friendCard: null,
  armory: [],
  database: [],
  selectedCharacter: null,
  selectedDatabaseEntry: null,
  activeChatFriend: null
};

const toast = $('#toast');
let toastTimer;
function showToast(message, duration = 2800) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

$$('[data-toast]').forEach((el) => {
  el.addEventListener('click', () => showToast(el.dataset.toast));
});

async function invokeTauri(command, args = {}) {
  if (!window.__TAURI__?.core?.invoke) return null;
  return window.__TAURI__.core.invoke(command, args);
}

function desktopAvailable() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

async function openExternal(url) {
  if (!url) return;
  try {
    await invokeTauri('open_external_url', { url });
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = bytes / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

// Connection failures from the web service read as one short sentence instead of the raw request error.
function serviceError(error) {
  const text = String(error);
  return /error sending request|timed out|connection/i.test(text)
    ? 'the Esteria web service is not responding. It may be offline; try again later.'
    : text;
}

function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 60) return `${Math.ceil(value)}s`;
  if (value < 3600) return `${Math.ceil(value / 60)}m`;
  return `${Math.floor(value / 3600)}h ${Math.ceil((value % 3600) / 60)}m`;
}

const navButtons = $$('.primary-nav-item');
const gameTabs = $$('.game-tab[data-view]');

function setLauncherView(view = 'home') {
  appState.activeView = view;
  appState.showingAddons = view === 'addons';
  $('#addonsSection').hidden = view !== 'addons';
  $('#armorySection').hidden = view !== 'armory';
  $('#databaseSection').hidden = view !== 'database';
  $('#toolsSection').hidden = view !== 'tools';
  $('#accountSection').hidden = view !== 'account';
  $('#statsSection').hidden = view !== 'stats';
  $('#linksSection').hidden = view !== 'links';
  $('#patchNotesSection').hidden = view !== 'patchnotes';
  $('#storySection').hidden = view !== 'story';
  $('#imagesSection').hidden = view !== 'images';
  $('#communitySection').hidden = view !== 'community';
  const showHome = view === 'home';
  $('#hero').hidden = !showHome;
  $('#newsSection').hidden = !showHome;
  $('.feed-section').hidden = !showHome;
  gameTabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === view || (['addons', 'links', 'patchnotes', 'story'].includes(view) && tab.dataset.view === 'home')));
  $('#mainContent').scrollTop = 0;
}

function restoreMainView() {
  setLauncherView('home');
}

gameTabs.forEach((tab) => {
  tab.addEventListener('click', async () => {
    const view = tab.dataset.view || 'home';
    document.body.classList.remove('mode-news', 'mode-community');
    navButtons.forEach((item) => item.classList.toggle('is-active', item.dataset.nav === 'games'));
    setLauncherView(view);
    if (view === 'armory') await refreshArmory();
    if (view === 'database') await refreshDatabase();
    if (view === 'tools') await refreshDiagnostics();
    if (view === 'account') await refreshGameAccount();
    if (view === 'stats') await refreshStats();
    if (view === 'images') await refreshImages();
  });
});

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    restoreMainView();
    navButtons.forEach((item) => item.classList.remove('is-active'));
    button.classList.add('is-active');
    document.body.classList.remove('mode-news', 'mode-community');
    if (button.dataset.nav === 'news') document.body.classList.add('mode-news');
    if (button.dataset.nav === 'community') {
      document.body.classList.add('mode-community');
      setLauncherView('community');
      refreshCommunity().catch((error) => console.warn('Could not load the community feed', error));
    }
    $('#mainContent').scrollTop = 0;
  });
});

let slides = [
  {
    className: 'hero-art-one',
    kicker: 'World Update',
    title: 'The gates of Esteria are open',
    body: 'Explore a custom Wrath-era world with new races, systems, and adventures built for Esteria.'
  },
  {
    className: 'hero-art-two',
    kicker: 'Playable Races',
    title: 'A larger world needs more heroes',
    body: 'Custom races and character options bring new identities to Azeroth while preserving the feel of Wrath of the Lich King.'
  },
  {
    className: 'hero-art-three',
    kicker: 'Launcher Preview',
    title: 'One home for every Esteria update',
    body: 'Install the client, check patch status, read development news, and keep your install ready to play.'
  }
];

let currentSlide = 0;
const heroArt = $('#heroArt');
const heroDots = $('#heroDots');
function renderHero() {
  const slide = slides[currentSlide];
  heroArt.className = `hero-art ${slide.className}`;
  $('#heroAction').textContent = slide.item?.body || slide.item?.url ? 'Read story' : 'Patch notes';
  $('#heroKicker').textContent = slide.kicker;
  $('#heroTitle').textContent = slide.title;
  $('#heroBody').textContent = slide.body;
  $$('.hero-dot').forEach((dot, index) => dot.classList.toggle('is-active', index === currentSlide));
}

function buildHeroDots() {
  heroDots.replaceChildren();
  slides.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'hero-dot';
    dot.setAttribute('aria-label', `Show story ${index + 1}`);
    dot.addEventListener('click', () => {
      currentSlide = index;
      renderHero();
    });
    heroDots.appendChild(dot);
  });
}
buildHeroDots();
renderHero();

// The marquee shows the newest stories from the CDN feed; the built-in slides are only a fallback.
function setHeroFromNews(items) {
  const arts = ['hero-art-one', 'hero-art-two', 'hero-art-three'];
  slides = items.slice(0, 3).map((item, index) => ({
    className: arts[index % arts.length],
    kicker: item.category || 'News',
    title: item.title || 'Esteria update',
    body: item.summary || '',
    item
  }));
  currentSlide = 0;
  buildHeroDots();
  renderHero();
}

$('#heroPrev').addEventListener('click', () => {
  currentSlide = (currentSlide - 1 + slides.length) % slides.length;
  renderHero();
});
$('#heroNext').addEventListener('click', () => {
  currentSlide = (currentSlide + 1) % slides.length;
  renderHero();
});
$('#heroAction').addEventListener('click', () => {
  const item = slides[currentSlide]?.item;
  if (item) openStory(item);
  else openPatchNotes();
});

const fallbackNewsImages = [
  './assets/news-world.svg',
  './assets/news-races.svg',
  './assets/news-launcher.svg'
];

function renderNews(items) {
  if (!Array.isArray(items) || !items.length) return;
  const grid = $('#newsGrid');
  grid.replaceChildren();
  appState.featuredNewsUrl = items[0]?.url || '';
  setHeroFromNews(items);

  items.slice(0, 24).forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'news-card';
    card.tabIndex = 0;
    const image = document.createElement('img');
    image.src = item.imageUrl || fallbackNewsImages[index % fallbackNewsImages.length];
    image.alt = '';
    const body = document.createElement('div');
    body.className = 'news-card-body';
    const meta = document.createElement('div');
    meta.className = 'news-meta';
    const date = item.publishedAt ? new Date(item.publishedAt) : null;
    const dateText = date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    meta.textContent = [item.category || 'News', dateText].filter(Boolean).join(' · ');
    const title = document.createElement('h3');
    title.textContent = item.title || 'Esteria update';
    const summary = document.createElement('p');
    summary.textContent = item.summary || '';
    body.append(meta, title, summary);
    card.append(image, body);

    card.classList.add('is-clickable');
    card.addEventListener('click', () => openStory(item));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openStory(item);
      }
    });
    grid.append(card);
  });
}

async function refreshNews() {
  if (!desktopAvailable() || !appState.settings.newsSource) return;
  try {
    const payload = await invokeTauri('fetch_news', { settings: appState.settings });
    const items = Array.isArray(payload) ? payload : payload?.items;
    if (Array.isArray(items) && items.length) renderNews(items);
  } catch (error) {
    console.warn('Could not load launcher news', error);
  }
  await refreshDevFeed();
}

function normalizePresence(value) {
  const presence = String(value || '').toLowerCase();
  return ['online', 'away', 'dnd', 'offline'].includes(presence) ? presence : 'offline';
}

function presenceLabel(value) {
  return { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Appear offline' }[normalizePresence(value)];
}

function mergedPresenceRecords() {
  const records = new Map();
  const snapshotPlayers = Array.isArray(appState.socialSnapshot?.players) ? appState.socialSnapshot.players : [];
  const onlineCharacters = Array.isArray(appState.serverStatus?.onlineCharacters) ? appState.serverStatus.onlineCharacters : [];

  snapshotPlayers.forEach((player) => {
    const names = [player.name, player.displayName, player.character?.name].filter(Boolean);
    names.forEach((name) => records.set(String(name).toLowerCase(), player));
  });
  onlineCharacters.forEach((character) => {
    const key = String(character.name || '').toLowerCase();
    if (!key) return;
    const existing = records.get(key) || {};
    records.set(key, {
      ...existing,
      name: existing.name || character.name,
      displayName: existing.displayName || character.name,
      presence: character.away ? 'away' : 'online',
      character: { ...(existing.character || {}), ...character }
    });
  });
  return records;
}

function conversationFor(friendName) {
  return appState.social?.conversations?.find((conversation) => conversation.friendName?.toLowerCase() === friendName.toLowerCase()) || null;
}

let discoverTimer;

function accountSession() {
  return appState.social?.account || null;
}

function accountApiBase() {
  const base = accountSession()?.apiBase || appState.settings.accountApi || '';
  return String(base).trim().replace(/\/+$/, '');
}

async function accountRequest(path, { method = 'GET', body, token } = {}) {
  const base = accountApiBase();
  if (!base) throw new Error('Set the Esteria account API address in settings first.');
  const authToken = token ?? accountSession()?.token;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Esteria account request failed (${response.status}).`);
  return payload;
}

const chatIncomingSound = new Audio('./assets/audio/incoming.mp3');
const chatOutgoingSound = new Audio('./assets/audio/outgoing.mp3');
chatIncomingSound.volume = 0.7;
chatOutgoingSound.volume = 0.55;

function playChatSound(kind) {
  const audio = kind === 'outgoing' ? chatOutgoingSound : chatIncomingSound;
  try {
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  } catch (error) {
    console.warn('Could not play the chat sound', error);
  }
}

async function chatWindowHandle() {
  const api = window.__TAURI__?.window;
  if (!api) return null;
  try {
    if (typeof api.getByLabel === 'function') return await api.getByLabel('chat');
    if (api.Window && typeof api.Window.getByLabel === 'function') return await api.Window.getByLabel('chat');
    if (typeof api.getAllWindows === 'function') {
      const windows = await api.getAllWindows();
      return (windows || []).find((entry) => entry.label === 'chat') || null;
    }
  } catch (error) {
    console.warn('Could not look up the chat window', error);
  }
  return null;
}

async function chatWindowVisible() {
  const handle = await chatWindowHandle();
  if (!handle) return false;
  try {
    return await handle.isVisible();
  } catch {
    return false;
  }
}

async function requestChatAttention() {
  const handle = await chatWindowHandle();
  if (!handle) return;
  try {
    if (await handle.isFocused()) return;
    await handle.requestUserAttention(2);
  } catch (error) {
    console.warn('Could not flash the chat window', error);
  }
}

async function openChatWindow(friend = null) {
  const handle = await chatWindowHandle();
  if (!handle) {
    openChatDialog(friend);
    return;
  }
  try {
    if (typeof handle.unminimize === 'function') await handle.unminimize();
    await handle.show();
    await handle.setFocus();
    appState.chatWindowOpen = true;
    // A never-shown window can still report itself as visible; only trust the check
    // once the launcher has actually opened the popout.
    appState.chatWindowShown = true;
    await invokeTauri('set_pending_chat', { friend: friend || '' });
    if (window.__TAURI__?.event?.emit) await window.__TAURI__.event.emit('chat-open', { friend });
  } catch (error) {
    console.warn('Could not open the chat window', error);
    openChatDialog(friend);
  }
}

function absoluteAvatarUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${accountApiBase()}${url}`;
}

function applyAvatar(element, url, initials) {
  if (!element) return;
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

async function refreshAccountFeed({ publish = true } = {}) {
  if (!accountSession()) {
    appState.accountFeed = null;
    return null;
  }
  const profile = appState.social?.profile || {};
  try {
    appState.accountFeed = await accountRequest('/api/v2/social/heartbeat', {
      method: 'POST',
      body: publish
        ? {
            presence: normalizePresence(profile.presence || 'online'),
            statusMessage: (appState.gamePresence ? gameStatusText(appState.gamePresence) : '') || profile.statusMessage || '',
            displayName: profile.displayName || ''
          }
        : {}
    });
  } catch (error) {
    console.warn('Could not refresh the Esteria account feed', error);
  }
  return appState.accountFeed;
}

function socialFriends() {
  if (accountSession() && appState.accountFeed) {
    return (appState.accountFeed.friends || []).map((friend) => ({
      name: friend.username,
      displayName: friend.displayName || friend.username,
      presence: normalizePresence(friend.presence),
      statusMessage: friend.statusMessage || '',
      note: friend.note || '',
      avatarUrl: absoluteAvatarUrl(friend.avatarUrl),
      character: {},
      unread: Number(friend.unread) || 0,
      online: normalizePresence(friend.presence) !== 'offline'
    }));
  }
  const friends = Array.isArray(appState.social?.friends) ? appState.social.friends : [];
  const presence = mergedPresenceRecords();
  const myName = appState.social?.profile?.displayName || '';
  return friends.map((friend) => {
    const live = presence.get(String(friend.name).toLowerCase()) || null;
    const state = live ? normalizePresence(live.presence || 'online') : 'offline';
    return {
      name: friend.name,
      displayName: live?.displayName || friend.name,
      presence: state,
      statusMessage: live?.statusMessage || '',
      note: friend.note || '',
      avatarUrl: '',
      character: live?.character || live || {},
      unread: (conversationFor(friend.name)?.messages || []).filter((message) => !message.read && message.sender !== myName).length,
      online: state !== 'offline'
    };
  });
}

function chatMessagesFor(friendName) {
  const session = accountSession();
  if (session) {
    const friend = (appState.accountFeed?.friends || []).find((entry) => entry.username.toLowerCase() === friendName.toLowerCase());
    return (appState.accountThreads[friendName.toLowerCase()] || []).map((message) => ({
      sender: message.from === session.username ? session.displayName || session.username : friend?.displayName || message.from,
      body: message.body,
      sentAt: Date.parse(message.createdAt) || 0,
      mine: message.from === session.username
    }));
  }
  const myName = appState.social?.profile?.displayName || '';
  return (conversationFor(friendName)?.messages || []).map((message) => ({ ...message, mine: message.sender === myName }));
}

async function loadAccountThread(friendName) {
  if (!accountSession() || !friendName) return;
  try {
    const payload = await accountRequest(`/api/v2/social/messages?with=${encodeURIComponent(friendName)}&since=0`);
    appState.accountThreads[friendName.toLowerCase()] = Array.isArray(payload?.messages) ? payload.messages : [];
    const last = appState.accountThreads[friendName.toLowerCase()].at(-1);
    if (last && !$('#chatBackdrop').hidden && appState.activeChatFriend?.toLowerCase() === friendName.toLowerCase() && document.hasFocus())
      await accountRequest('/api/v2/social/chat/op', {method: 'POST', body: {op: 'read', conversation: `dm:${friendName}`, cursor: last.id}});
  } catch (error) {
    console.warn('Could not load that conversation', error);
  }
}

function renderSocialPanel() {
  const social = appState.social || { profile: {}, friends: [], conversations: [], preferences: {} };
  const profile = social.profile || {};
  const session = accountSession();
  const displayName = profile.displayName || 'Player';
  $('#profileDisplayName').textContent = displayName;
  const myAvatar = session && appState.accountFeed?.me ? absoluteAvatarUrl(appState.accountFeed.me.avatarUrl) : '';
  applyAvatar($('#profileAvatar'), myAvatar, displayName.slice(0, 2).toUpperCase() || 'P');
  $('#profilePresenceText').textContent = presenceLabel(profile.presence);
  $('#profileStatusMessage').textContent =
    (appState.gamePresence ? gameStatusText(appState.gamePresence) : '') ||
    profile.statusMessage ||
    (profile.favoriteCharacter ? `Favorite: ${profile.favoriteCharacter}` : session ? `Signed in as @${session.username}` : '');
  const profileDot = $('#profilePresenceDot');
  profileDot.className = `status-dot ${normalizePresence(profile.presence)}`;

  const list = $('#friendsList');
  list.replaceChildren();
  const friends = socialFriends();
  const incoming = session && appState.accountFeed ? appState.accountFeed.incoming || [] : [];
  const query = $('#socialSearch').value.trim().toLowerCase();
  const onlineOnly = social.preferences?.showOnlineFriendsOnly === true;
  const visibleFriends = friends
    .filter((friend) => {
      if (onlineOnly && !friend.online) return false;
      return (
        !query ||
        friend.name.toLowerCase().includes(query) ||
        friend.displayName.toLowerCase().includes(query) ||
        friend.note.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const rank = (friend) => (friend.favorite ? 0 : friend.online ? 1 : 2);
      return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
    });

  const heading = document.createElement('div');
  heading.className = 'friend-group-heading';
  heading.textContent = `Friends · ${visibleFriends.length}/${friends.length}`;
  list.append(heading);

  if (incoming.length) {
    const requestHeading = document.createElement('div');
    requestHeading.className = 'friend-group-heading';
    requestHeading.textContent = `Friend requests · ${incoming.length}`;
    list.append(requestHeading);
    incoming.forEach((request) => {
      const row = document.createElement('button');
      row.className = 'friend-row is-request';
      row.type = 'button';
      row.title = 'Accept friend request';
      const avatar = document.createElement('span');
      avatar.className = 'friend-avatar';
      applyAvatar(avatar, absoluteAvatarUrl(request.avatarUrl), String(request.displayName || request.username).slice(0, 2).toUpperCase());
      const copy = document.createElement('span');
      copy.className = 'friend-copy';
      const name = document.createElement('strong');
      name.textContent = request.displayName || request.username;
      const detail = document.createElement('small');
      detail.textContent = `@${request.username} wants to be friends`;
      copy.append(name, detail);
      const accept = document.createElement('span');
      accept.className = 'friend-accept';
      accept.textContent = 'Accept';
      row.append(avatar, copy, accept);
      row.addEventListener('click', () => acceptFriendRequest(request.username));
      list.append(row);
    });
  }

  if (!visibleFriends.length) {
    const empty = document.createElement('div');
    empty.className = 'friends-empty';
    empty.textContent = friends.length ? 'No friends match the current filter.' : 'No friends added yet.';
    list.append(empty);
  }

  let lastCategory = '';
  visibleFriends.forEach((friend, index) => {
    const category = friend.favorite ? 'Favorites' : friend.online ? 'Online' : 'Offline';
    if (category !== lastCategory) {
      lastCategory = category;
      const groupHeading = document.createElement('div');
      groupHeading.className = 'friend-group-heading';
      groupHeading.textContent = category;
      list.append(groupHeading);
    }
    const row = document.createElement('button');
    row.className = 'friend-row';
    row.type = 'button';
    row.dataset.name = friend.name;
    const stateValue = friend.presence;
    if (!friend.online) row.classList.add('is-offline');

    const avatar = document.createElement('span');
    avatar.className = friend.avatarUrl ? 'friend-avatar' : `friend-avatar avatar-${(index % 8) + 1}`;
    applyAvatar(avatar, friend.avatarUrl, friend.displayName.slice(0, 2).toUpperCase());
    const copy = document.createElement('span');
    copy.className = 'friend-copy';
    const name = document.createElement('strong');
    name.textContent = friend.displayName;
    const detail = document.createElement('small');
    const character = friend.character || {};
    const characterParts = social.preferences?.showCharacterDetails === false
      ? []
      : [character.zone, character.className || character.class, character.level ? `Level ${character.level}` : ''].filter(Boolean);
    detail.textContent = characterParts.join(' · ') || friend.statusMessage || friend.note || presenceLabel(stateValue);
    copy.append(name, detail);
    const state = document.createElement('span');
    state.className = `friend-state ${stateValue}`;
    row.append(avatar, copy, state);
    row.addEventListener('click', () => openFriendCard(friend.name));
    row.addEventListener('dblclick', () => openArmoryFor(friend.name));
    row.title = 'Click for the profile card · double-click for Armory · right-click for actions';
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showFriendMenu(event.clientX, event.clientY, friend.name);
    });
    list.append(row);
  });

  const unread = session && appState.accountFeed
    ? Number(appState.accountFeed.unread) || 0
    : social.conversations?.reduce((total, conversation) => total + (conversation.messages || []).filter((message) => !message.read && message.sender !== displayName).length, 0) || 0;
  const badge = $('#chatUnreadCount');
  badge.hidden = unread === 0;
  badge.textContent = unread ? String(unread) : '';
}

async function refreshSocialSnapshot() {
  if (!desktopAvailable() || !appState.settings.socialSource) {
    appState.socialSnapshot = null;
    renderSocialPanel();
    return;
  }
  try {
    appState.socialSnapshot = await invokeTauri('fetch_social_snapshot', { settings: appState.settings });
  } catch (error) {
    appState.socialSnapshot = null;
    console.warn('Could not load social presence snapshot', error);
  }
  renderSocialPanel();
}

async function refreshServerStatus() {
  const detail = $('#realmDetail');
  if (!desktopAvailable() || !appState.settings.statusSource) {
    detail.textContent = '';
    renderSocialPanel();
    return;
  }
  try {
    const status = await invokeTauri('fetch_server_status', { settings: appState.settings });
    appState.serverStatus = status || null;
    renderSocialPanel();
    const parts = [];
    if (Number.isFinite(Number(status?.onlinePlayers))) {
      const players = Number(status.onlinePlayers);
      parts.push(`${players} player${players === 1 ? '' : 's'} online`);
    }
    const channel = appState.settings.channel === 'ptr' ? 'ptr' : 'live';
    const build = status?.channels?.[channel]?.version;
    if (build) parts.push(`${channel.toUpperCase()} ${build}`);
    if (status?.maintenance) parts.unshift('Maintenance');
    detail.textContent = parts.join(' · ') || status?.motd || '';
    if (status?.message) detail.title = status.message;
  } catch (error) {
    detail.textContent = '';
    console.warn('Could not load server status', error);
  }
}

async function checkLauncherUpdate({ silent = false } = {}) {
  if (!desktopAvailable() || appState.launcherUpdating) return null;
  const banner = $('#launcherUpdateBanner');
  try {
    const update = await invokeTauri('check_launcher_update');
    appState.launcherUpdate = update || null;
    banner.hidden = !update;
    if (update) {
      $('#launcherUpdateText').textContent = `Launcher ${update.version} available`;
      if (!silent) showToast(`Launcher ${update.version} is available.`);
    } else if (!silent) {
      showToast('Launcher is up to date.');
    }
    return update;
  } catch (error) {
    if (!silent) showToast(String(error), 5200);
    console.warn('Could not check launcher update', error);
    return null;
  }
}

async function installLauncherUpdate() {
  if (appState.launcherUpdating) return;
  appState.launcherUpdating = true;
  const button = $('#installLauncherUpdateButton');
  button.disabled = true;
  button.textContent = 'Installing…';
  $('#launcherUpdateText').textContent = 'Downloading launcher update…';
  try {
    await invokeTauri('install_launcher_update');
    showToast('Launcher update installed. Restarting…');
  } catch (error) {
    showToast(String(error), 6500);
    button.disabled = false;
    button.textContent = 'Install';
    appState.launcherUpdating = false;
  }
}

$('#installLauncherUpdateButton').addEventListener('click', installLauncherUpdate);

function renderAccountPanel() {
  const session = accountSession();
  const me = appState.accountFeed?.me || null;
  const signedIn = Boolean(session);
  $('#accountSignedOut').hidden = signedIn;
  $('#accountSignedIn').hidden = !signedIn;
  const name = signedIn ? me?.displayName || session.displayName || session.username : 'Not signed in';
  $('#accountName').textContent = signedIn ? `${name} · @${session.username}` : 'Not signed in';
  const linkedGame = signedIn ? me?.gameAccount : null;
  $('#accountGameLink').textContent = !signedIn ? '' : linkedGame
    ? `Linked to game account ${linkedGame} · permanent`
    : 'Not linked to a game account yet. Sign in on the Game Account tab to link it.';
  $('#accountGameLink').classList.toggle('is-linked', Boolean(linkedGame));
  $('#accountHint').textContent = signedIn
    ? 'Presence, friends, chats, and your profile picture live on the Esteria account service.'
    : 'Create an Esteria account to share your presence, friends, and chat with other players.';
  applyAvatar($('#accountAvatar'), signedIn && me ? absoluteAvatarUrl(me.avatarUrl) : '', signedIn ? String(name).slice(0, 2).toUpperCase() : '?');
}

async function signInAccount({ register = false } = {}) {
  if (appState.accountBusy) return;
  const username = $('#accountUsernameInput').value.trim();
  const password = $('#accountPasswordInput').value;
  if (!username || !password) {
    showToast('Enter your account name and password.');
    return;
  }
  const email = $('#accountEmailInput').value.trim();
  if (register && appState.settings.gameApi && !email) {
    showToast('Enter an email address to create your account.');
    return;
  }
  appState.accountBusy = true;
  try {
    // Same name and password for the game; the game account is created first so a taken name fails early.
    if (register && appState.settings.gameApi) await gameRegister(username, password, email);
    const payload = await accountRequest(register ? '/api/v2/account/register' : '/api/v2/account/login', {
      method: 'POST',
      body: register
        ? { username, password, displayName: appState.social?.profile?.displayName }
        : { username, password }
    });
    const account = payload?.account || {};
    const previous = appState.social?.profile || {};
    appState.social = await invokeTauri('save_account_session', {
      session: {
        token: payload.token,
        username: account.username || username.toLowerCase(),
        displayName: account.displayName || username,
        apiBase: accountApiBase()
      }
    });
    appState.social = await invokeTauri('save_player_profile', {
      profile: {
        displayName: account.displayName || username,
        presence: previous.presence || 'online',
        statusMessage: account.statusMessage || '',
        favoriteCharacter: previous.favoriteCharacter || ''
      }
    });
    if (appState.settings.gameApi) {
      await gameLogin(username, password).catch((error) => showToast(`Signed in, but the game account could not be linked: ${error}`, 6000));
    }
    $('#accountPasswordInput').value = '';
    await refreshGamePresence();
    await refreshAccountFeed();
    await autoLinkGameProfile();
    renderAccountPanel();
    renderSocialPanel();
    showToast(register ? `Esteria account ${account.username} created.` : `Signed in as ${account.username}.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
  appState.accountBusy = false;
}

async function signOutAccount() {
  await gameSignOut();
  try {
    await accountRequest('/api/v2/account/logout', { method: 'POST', body: {} });
  } catch (error) {
    console.warn('Sign-out call failed', error);
  }
  appState.accountFeed = null;
  appState.accountThreads = {};
  appState.discoverResults = [];
  appState.activeChatFriend = null;
  try {
    appState.social = await invokeTauri('clear_account_session');
  } catch (error) {
    console.warn('Could not clear the stored account session', error);
  }
  renderAccountPanel();
  renderSocialPanel();
  renderChatDialog();
  showToast('Signed out of your Esteria account.');
}

async function uploadAccountAvatar() {
  if (!accountSession()) return;
  const picked = await invokeTauri('pick_upload', { kind: 'avatar' });
  if (!picked) return;
  try {
    await accountRequest('/api/v2/account/avatar', {
      method: 'PUT',
      body: { mimeType: picked.mimeType, dataBase64: picked.dataBase64 }
    });
    await refreshAccountFeed({ publish: false });
    renderAccountPanel();
    renderSocialPanel();
    showToast('Profile picture updated.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function clearAccountAvatar() {
  if (!accountSession()) return;
  try {
    await accountRequest('/api/v2/account/avatar', { method: 'DELETE' });
    await refreshAccountFeed({ publish: false });
    renderAccountPanel();
    renderSocialPanel();
    showToast('Profile picture removed.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function acceptFriendRequest(username) {
  try {
    appState.accountFeed = await accountRequest('/api/v2/social/friends/accept', { method: 'POST', body: { username } });
    renderSocialPanel();
    showToast(`@${username} added to your friends.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function searchPlayers(query) {
  if (!accountSession()) {
    appState.discoverResults = [];
    renderDiscoverResults();
    return;
  }
  try {
    const payload = await accountRequest(`/api/v2/social/discover?q=${encodeURIComponent(query)}`);
    appState.discoverResults = Array.isArray(payload?.players) ? payload.players : [];
  } catch (error) {
    appState.discoverResults = [];
    console.warn('Player search failed', error);
  }
  renderDiscoverResults();
}

function renderDiscoverResults() {
  const root = $('#discoverResults');
  const results = appState.discoverResults || [];
  root.replaceChildren();
  root.hidden = !accountSession() || !results.length;
  results.forEach((player) => {
    const row = document.createElement('div');
    row.className = 'discover-row';
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = player.displayName || player.username;
    const detail = document.createElement('small');
    detail.textContent = `@${player.username} · ${presenceLabel(player.presence)}`;
    copy.append(name, detail);
    const action = document.createElement('button');
    action.type = 'button';
    const relation = player.relation || 'none';
    action.textContent = relation === 'friend' ? 'Friends' : relation === 'requested' ? 'Requested' : relation === 'incoming' ? 'Accept' : 'Add';
    action.disabled = relation === 'friend' || relation === 'requested';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        appState.accountFeed = await accountRequest(
          relation === 'incoming' ? '/api/v2/social/friends/accept' : '/api/v2/social/friends',
          { method: 'POST', body: { username: player.username } }
        );
        await searchPlayers($('#friendNameInput').value.trim());
        renderSocialPanel();
        showToast(`@${player.username} added to your friends.`);
      } catch (error) {
        action.disabled = false;
        showToast(String(error), 5200);
      }
    });
    row.append(copy, action);
    root.append(row);
  });
}

// ---- friend profile card, context menu, community feed -----------------

function friendRecord(name) {
  const key = String(name).toLowerCase();
  const remote = (appState.accountFeed?.friends || []).find((entry) => entry.username.toLowerCase() === key);
  if (remote) {
    return {
      name: remote.username,
      displayName: remote.displayName || remote.username,
      avatarUrl: absoluteAvatarUrl(remote.avatarUrl),
      presence: normalizePresence(remote.presence),
      statusMessage: remote.statusMessage || '',
      bio: remote.bio || '',
      headerUrl: absoluteAvatarUrl(remote.headerUrl),
      note: remote.note || '',
      favorite: remote.favorite === true,
      account: true
    };
  }
  const local = (appState.social?.friends || []).find((entry) => entry.name.toLowerCase() === key);
  const live = mergedPresenceRecords().get(key) || null;
  return {
    name: local?.name || name,
    displayName: live?.displayName || local?.name || name,
    avatarUrl: '',
    presence: live ? normalizePresence(live.presence || 'online') : 'offline',
    statusMessage: live?.statusMessage || '',
    bio: '',
    headerUrl: '',
    note: local?.note || '',
    favorite: local?.favorite === true,
    account: false
  };
}

async function openFriendCard(name) {
  const record = friendRecord(name);
  renderFriendCard(record);
  $('#profileCardBackdrop').hidden = false;
  if (accountSession() && record.account) {
    try {
      const payload = await accountRequest(`/api/v2/social/profiles/${encodeURIComponent(record.name)}`);
      if (payload?.profile) renderFriendCard({ ...record, ...payload.profile, account: true });
    } catch (error) {
      console.warn('Could not load that profile', error);
    }
  }
}

function renderFriendCard(record) {
  appState.friendCard = record;
  const displayName = record.displayName || record.name;
  $('#profileCardName').textContent = record.note ? `${record.note} (${displayName})` : displayName;
  $('#profileCardHandle').textContent = `@${record.name}`;
  $('#profileCardPresence').textContent = presenceLabel(record.presence);
  $('#profileCardDot').className = `status-dot ${normalizePresence(record.presence)}`;
  $('#profileCardStatus').textContent = record.statusMessage || '';
  $('#profileCardBio').textContent = record.bio || 'No bio yet.';
  const avatarUrl = absoluteAvatarUrl(record.avatarUrl);
  const headerUrl = absoluteAvatarUrl(record.headerUrl);
  applyAvatar($('#profileCardAvatar'), avatarUrl, displayName.slice(0, 2).toUpperCase());
  const header = $('#profileCardHeader');
  header.style.backgroundImage = headerUrl ? `url("${headerUrl}")` : '';
  header.classList.toggle('is-empty', !headerUrl);
  $('#profileCardFavoriteButton').textContent = record.favorite ? '★ Favorite' : '☆ Favorite';
  $('#profileCardMessageButton').disabled = false;
}

function closeFriendCard() {
  $('#profileCardBackdrop').hidden = true;
  appState.friendCard = null;
}

function showFriendMenu(x, y, name) {
  const menu = $('#friendContextMenu');
  const record = friendRecord(name);
  menu.replaceChildren();
  const items = [
    { label: 'View profile', run: () => openFriendCard(record.name) },
    { label: 'Send message', run: () => openChatWindow(record.name) },
    { label: record.note ? `Nickname: ${record.note}` : 'Set nickname…', run: () => setFriendNickname(record.name) },
    { label: record.favorite ? '★ Remove favorite' : '☆ Add favorite', run: () => setFriendFavorite(record.name, !record.favorite) },
    { label: 'Remove friend', run: () => removeFriend(record.name), danger: true }
  ];
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    if (item.danger) button.classList.add('is-danger');
    button.textContent = item.label;
    button.addEventListener('click', () => {
      hideFriendMenu();
      item.run();
    });
    menu.append(button);
  });
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 190)}px`;
}

function hideFriendMenu() {
  $('#friendContextMenu').hidden = true;
}

async function setFriendNickname(name) {
  if (!accountSession()) {
    showToast('Sign in to your Esteria account to set nicknames.');
    return;
  }
  const current = friendRecord(name).note;
  const next = window.prompt(`Nickname for ${name}`, current);
  if (next === null) return;
  try {
    appState.accountFeed = await accountRequest(`/api/v2/social/friends/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: { nickname: next.trim() }
    });
    renderSocialPanel();
    if (appState.friendCard?.name?.toLowerCase() === name.toLowerCase()) renderFriendCard(friendRecord(name));
    showToast(next.trim() ? `Nickname saved for ${name}.` : `Nickname cleared for ${name}.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function setFriendFavorite(name, favorite) {
  if (!accountSession()) {
    showToast('Sign in to your Esteria account to manage favorites.');
    return;
  }
  try {
    appState.accountFeed = await accountRequest(`/api/v2/social/friends/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: { favorite }
    });
    renderSocialPanel();
    if (appState.friendCard?.name?.toLowerCase() === name.toLowerCase()) renderFriendCard(friendRecord(name));
    showToast(favorite ? `${name} is now a favorite.` : `${name} is no longer a favorite.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function uploadHeader() {
  if (!accountSession()) {
    showToast('Sign in to your Esteria account to set a profile header.');
    return;
  }
  const picked = await invokeTauri('pick_upload', { kind: 'header' });
  if (!picked) return;
  try {
    await accountRequest('/api/v2/account/header', {
      method: 'PUT',
      body: { mimeType: picked.mimeType, dataBase64: picked.dataBase64 }
    });
    await refreshAccountFeed({ publish: false });
    renderAccountPanel();
    showToast('Profile header updated.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function clearHeader() {
  if (!accountSession()) return;
  try {
    await accountRequest('/api/v2/account/header', { method: 'DELETE' });
    await refreshAccountFeed({ publish: false });
    renderAccountPanel();
    showToast('Profile header removed.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function formatPostTime(value) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function refreshCommunity() {
  const feed = $('#postFeed');
  if (!accountSession()) {
    feed.replaceChildren();
    const note = document.createElement('div');
    note.className = 'empty-detail';
    note.textContent = 'Sign in to your Esteria account to post updates friends can see.';
    feed.append(note);
    return;
  }
  try {
    const payload = await accountRequest('/api/v2/social/posts?since=0');
    appState.posts = Array.isArray(payload?.posts) ? payload.posts : [];
  } catch (error) {
    appState.posts = [];
    console.warn('Could not load the community feed', error);
  }
  renderCommunity();
}

function renderCommunity() {
  const feed = $('#postFeed');
  feed.replaceChildren();
  const posts = appState.posts || [];
  if (!posts.length) {
    const note = document.createElement('div');
    note.className = 'empty-detail';
    note.textContent = 'No posts yet. Share the first update.';
    feed.append(note);
    return;
  }
  const myName = accountSession()?.username || '';
  posts.forEach((post) => {
    const card = document.createElement('article');
    card.className = 'post-card';
    const head = document.createElement('div');
    head.className = 'post-head';
    const avatar = document.createElement('span');
    avatar.className = 'post-avatar';
    applyAvatar(avatar, absoluteAvatarUrl(post.author?.avatarUrl), String(post.author?.displayName || post.author?.username || '?').slice(0, 2).toUpperCase());
    const who = document.createElement('div');
    who.className = 'post-who';
    const name = document.createElement('strong');
    name.textContent = post.author?.displayName || post.author?.username || 'Unknown';
    const meta = document.createElement('small');
    meta.textContent = `@${post.author?.username || 'unknown'} · ${formatPostTime(post.createdAt)}`;
    who.append(name, meta);
    head.append(avatar, who);
    if (post.author?.username === myName) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'post-delete';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deletePost(post.id));
      head.append(remove);
    }
    card.append(head);
    if (post.body) {
      const body = document.createElement('p');
      body.className = 'post-body';
      body.textContent = post.body;
      card.append(body);
    }
    if (post.mediaUrl) {
      const media = post.mediaKind === 'video' ? document.createElement('video') : document.createElement('img');
      media.src = absoluteAvatarUrl(post.mediaUrl);
      if (post.mediaKind === 'video') {
        media.controls = true;
      } else {
        media.alt = '';
        media.loading = 'lazy';
      }
      media.className = 'post-media';
      card.append(media);
    }
    feed.append(card);
  });
}

async function attachPostMedia() {
  const picked = await invokeTauri('pick_upload', { kind: 'post' });
  if (!picked) return;
  appState.postMedia = picked;
  $('#postAttachmentName').textContent = picked.name || 'attached';
}

async function publishPost() {
  if (!accountSession()) {
    showToast('Sign in to your Esteria account to post.');
    return;
  }
  const body = $('#postBodyInput').value.trim();
  const media = appState.postMedia;
  if (!body && !media) {
    showToast('Write something or attach a file first.');
    return;
  }
  try {
    const payload = await accountRequest('/api/v2/social/posts', {
      method: 'POST',
      body: {
        body,
        ...(media ? { mimeType: media.mimeType, dataBase64: media.dataBase64 } : {})
      }
    });
    $('#postBodyInput').value = '';
    $('#postAttachmentName').textContent = '';
    appState.postMedia = null;
    if (payload?.post) appState.posts = [payload.post, ...(appState.posts || [])];
    renderCommunity();
    showToast('Posted to your friends.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function deletePost(postId) {
  if (!window.confirm('Delete this post?')) return;
  try {
    await accountRequest(`/api/v2/social/posts/${postId}`, { method: 'DELETE' });
    appState.posts = (appState.posts || []).filter((post) => post.id !== postId);
    renderCommunity();
  } catch (error) {
    showToast(String(error), 5200);
  }
}

// ---- close and play prompts -------------------------------------------

function rememberedCloseAction() {
  const value = appState.settings.closeAction;
  return ['close', 'tray', 'minimize'].includes(value) ? value : 'ask';
}

function rememberedPlayAction() {
  const value = appState.settings.playAction;
  return ['minimize', 'tray', 'keep'].includes(value) ? value : 'ask';
}

async function persistSetting(key, value) {
  const next = { ...appState.settings, [key]: value };
  try {
    const saved = await invokeTauri('save_settings', { settings: next });
    appState.settings = saved || next;
  } catch (error) {
    console.warn('Could not save that preference', error);
    appState.settings = next;
  }
  if (closeActionSelect) closeActionSelect.value = appState.settings.closeAction || 'ask';
  if (playActionSelect) playActionSelect.value = appState.settings.playAction || 'ask';
}

async function applyCloseAction(action) {
  if (action === 'close') {
    await invokeTauri('quit_launcher');
    return;
  }
  if (action === 'tray') {
    await invokeTauri('hide_main_window');
    return;
  }
  await invokeTauri('minimize_main_window');
}

async function handleCloseRequest() {
  const remembered = rememberedCloseAction();
  if (remembered !== 'ask') {
    await applyCloseAction(remembered);
    return;
  }
  $('#closeRememberInput').checked = false;
  $('#closeBackdrop').hidden = false;
}

async function chooseCloseAction(action) {
  $('#closeBackdrop').hidden = true;
  if ($('#closeRememberInput').checked) await persistSetting('closeAction', action);
  await applyCloseAction(action);
}

async function startGame(action) {
  try {
    if (action === 'minimize' || action === 'tray') await invokeTauri('apply_play_action', { action });
    const result = await invokeTauri('launch_game', { settings: appState.settings });
    showToast(result === null ? 'Desktop launch hook is ready.' : 'Esteria has closed.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function choosePlayAction(action) {
  $('#playBackdrop').hidden = true;
  if ($('#playRememberInput').checked) await persistSetting('playAction', action);
  await startGame(action);
}

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event
    .listen('launcher-close-requested', () => {
      handleCloseRequest().catch((error) => console.warn('Could not handle the close request', error));
    })
    .catch((error) => console.warn('Could not listen for close requests', error));
}

$('#closeMinimizeButton').addEventListener('click', () => chooseCloseAction('minimize'));
$('#closeTrayButton').addEventListener('click', () => chooseCloseAction('tray'));
$('#closeExitButton').addEventListener('click', () => chooseCloseAction('close'));
$('#closeCancelButton').addEventListener('click', () => {
  $('#closeBackdrop').hidden = true;
});
$('#playMinimizeButton').addEventListener('click', () => choosePlayAction('minimize'));
$('#playTrayButton').addEventListener('click', () => choosePlayAction('tray'));
$('#playKeepButton').addEventListener('click', () => choosePlayAction('keep'));
$('#playCancelButton').addEventListener('click', () => {
  $('#playBackdrop').hidden = true;
});

$('#socialSearch').addEventListener('input', renderSocialPanel);
$('#refreshCommunityButton').addEventListener('click', () => refreshCommunity());
$('#attachPostButton').addEventListener('click', attachPostMedia);
$('#publishPostButton').addEventListener('click', publishPost);
$('#profileCardCloseButton').addEventListener('click', closeFriendCard);
$('#profileCardBackdrop').addEventListener('click', (event) => { if (event.target === $('#profileCardBackdrop')) closeFriendCard(); });
$('#profileCardMessageButton').addEventListener('click', () => {
  if (appState.friendCard) openChatWindow(appState.friendCard.name);
});
$('#profileCardNicknameButton').addEventListener('click', () => {
  if (appState.friendCard) setFriendNickname(appState.friendCard.name);
});
$('#profileCardFavoriteButton').addEventListener('click', () => {
  if (appState.friendCard) setFriendFavorite(appState.friendCard.name, !appState.friendCard.favorite);
});
$('#profileCardRemoveButton').addEventListener('click', () => {
  if (!appState.friendCard) return;
  const name = appState.friendCard.name;
  closeFriendCard();
  removeFriend(name);
});
$('#headerImageButton').addEventListener('click', uploadHeader);
$('#headerClearButton').addEventListener('click', clearHeader);
document.addEventListener('click', (event) => {
  if (!event.target.closest('#friendContextMenu') && !event.target.closest('.friend-row')) hideFriendMenu();
});
document.addEventListener('scroll', hideFriendMenu, true);

const settingsBackdrop = $('#settingsBackdrop');
const pathInput = $('#gamePathInput');
const manifestInput = $('#manifestSourceInput');
const addonCatalogInput = $('#addonCatalogInput');
const newsSourceInput = $('#newsSourceInput');
const statusSourceInput = $('#statusSourceInput');
const socialSourceInput = $('#socialSourceInput');
const accountApiInput = $('#accountApiInput');
const armorySourceInput = $('#armorySourceInput');
const databaseSourceInput = $('#databaseSourceInput');
const patchListInput = $('#patchListInput');
const cleanWdbInput = $('#cleanWdbInput');
const closeActionSelect = $('#closeActionSelect');
const playActionSelect = $('#playActionSelect');

const autoUpdateAddonsInput = $('#autoUpdateAddonsInput');
const realmHostInput = $('#realmHostInput');
const realmPortInput = $('#realmPortInput');
const playButton = $('#playButton');
const updateLabel = $('#updateLabel');
const updatePercent = $('#updatePercent');
const progressFill = $('#progressFill');
const versionSelect = $('#versionSelect');

async function loadSocialState() {
  if (!desktopAvailable()) {
    appState.social = {
      profile: { displayName: 'Player', presence: 'online', statusMessage: '', favoriteCharacter: '' },
      friends: [],
      conversations: [],
      preferences: { showOnlineFriendsOnly: true, desktopNotifications: true, showCharacterDetails: true }
    };
    renderSocialPanel();
    return appState.social;
  }
  try {
    appState.social = await invokeTauri('get_social_state');
  } catch (error) {
    console.warn('Could not load social state', error);
    appState.social = null;
  }
  renderSocialPanel();
  return appState.social;
}

function openProfileDialog() {
  const profile = appState.social?.profile || {};
  renderAccountPanel();
  $('#profileNameInput').value = profile.displayName || 'Player';
  $('#profilePresenceSelect').value = normalizePresence(profile.presence || 'online');
  $('#profileStatusInput').value = profile.statusMessage || '';
  $('#profileBioInput').value = profile.bio || '';
  $('#favoriteCharacterInput').value = profile.favoriteCharacter || '';
  $('#profileBackdrop').hidden = false;
  requestAnimationFrame(() => $('#profileNameInput').focus());
}

function closeProfileDialog() {
  $('#profileBackdrop').hidden = true;
}

async function saveProfile() {
  try {
    appState.social = await invokeTauri('save_player_profile', {
      profile: {
        displayName: $('#profileNameInput').value.trim(),
        presence: $('#profilePresenceSelect').value,
        statusMessage: $('#profileStatusInput').value.trim(),
        bio: $('#profileBioInput').value.trim(),
        favoriteCharacter: $('#favoriteCharacterInput').value.trim()
      }
    });
    if (accountSession()) await refreshAccountFeed();
    closeProfileDialog();
    renderAccountPanel();
    renderSocialPanel();
    showToast('Profile and presence updated.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function openSocialSettingsDialog() {
  const preferences = appState.social?.preferences || {};
  $('#showOnlineOnlyInput').checked = preferences.showOnlineFriendsOnly === true;
  $('#desktopNotificationsInput').checked = preferences.desktopNotifications !== false;
  $('#showCharacterDetailsInput').checked = preferences.showCharacterDetails !== false;
  $('#socialSettingsBackdrop').hidden = false;
}

function closeSocialSettingsDialog() {
  $('#socialSettingsBackdrop').hidden = true;
}

async function saveSocialSettings() {
  try {
    appState.social = await invokeTauri('save_social_preferences', {
      preferences: {
        showOnlineFriendsOnly: $('#showOnlineOnlyInput').checked,
        desktopNotifications: $('#desktopNotificationsInput').checked,
        showCharacterDetails: $('#showCharacterDetailsInput').checked
      }
    });
    closeSocialSettingsDialog();
    renderSocialPanel();
    showToast('Social settings saved.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function updateFriendDialogHint() {
  $('#friendHint').textContent = accountSession()
    ? 'Search Esteria accounts by name. Requests reach the other player the next time they sign in.'
    : 'Sign in to your Esteria account to find players. Without an account, friends stay on this PC and are matched against the shared presence snapshot.';
}

function openFriendDialog() {
  $('#friendNameInput').value = '';
  appState.discoverResults = [];
  renderDiscoverResults();
  updateFriendDialogHint();
  $('#friendBackdrop').hidden = false;
  requestAnimationFrame(() => $('#friendNameInput').focus());
}

function closeFriendDialog() {
  $('#friendBackdrop').hidden = true;
}

async function addFriendFromDialog() {
  const name = $('#friendNameInput').value.trim();
  if (!name) {
    showToast('Enter a player or character name.');
    return;
  }
  try {
    if (accountSession()) {
      const match = (appState.discoverResults || []).find((player) => player.username.toLowerCase() === name.toLowerCase());
      appState.accountFeed = await accountRequest('/api/v2/social/friends', {
        method: 'POST',
        body: { username: match?.username || name }
      });
      closeFriendDialog();
      renderSocialPanel();
      showToast(`${match?.displayName || name} added to friends.`);
      return;
    }
    appState.social = await invokeTauri('add_friend', { name });
    closeFriendDialog();
    renderSocialPanel();
    showToast(`${name} added to friends.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function removeFriend(name) {
  if (!window.confirm(`Remove ${name} from your friends list?`)) return;
  try {
    if (accountSession()) {
      appState.accountFeed = await accountRequest(`/api/v2/social/friends/${encodeURIComponent(name)}`, { method: 'DELETE' });
      delete appState.accountThreads[name.toLowerCase()];
      if (appState.activeChatFriend?.toLowerCase() === name.toLowerCase()) appState.activeChatFriend = null;
      renderSocialPanel();
      renderChatDialog();
      showToast(`${name} removed from friends.`);
      return;
    }
    appState.social = await invokeTauri('remove_friend', { name });
    if (appState.activeChatFriend?.toLowerCase() === name.toLowerCase()) appState.activeChatFriend = null;
    renderSocialPanel();
    renderChatDialog();
    showToast(`${name} removed from friends.`);
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function renderChatDialog() {
  const social = appState.social || { profile: {}, friends: [], conversations: [] };
  const friends = socialFriends();
  const threads = $('#chatThreadList');
  threads.replaceChildren();

  if (!friends.length) {
    const empty = document.createElement('div');
    empty.className = 'friends-empty';
    empty.textContent = 'Add a friend to start a chat.';
    threads.append(empty);
  }

  friends.forEach((friend) => {
    const messages = chatMessagesFor(friend.name);
    const last = messages[messages.length - 1];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-thread';
    if (appState.activeChatFriend?.toLowerCase() === friend.name.toLowerCase()) button.classList.add('is-active');
    const name = document.createElement('strong');
    name.textContent = friend.displayName || friend.name;
    const preview = document.createElement('small');
    preview.textContent = last?.body || 'No messages yet';
    button.append(name, preview);
    button.addEventListener('click', () => {
      appState.activeChatFriend = friend.name;
      renderChatDialog();
      requestAnimationFrame(() => $('#chatInput').focus());
    });
    threads.append(button);
  });

  const messagesRoot = $('#chatMessages');
  messagesRoot.replaceChildren();
  const active = appState.activeChatFriend;
  $('#chatSubtitle').textContent = active || 'Select a friend';
  $('#removeChatFriendButton').hidden = !active;
  $('#chatInput').disabled = !active;
  $('#sendChatButton').disabled = !active;

  if (!active) {
    const empty = document.createElement('div');
    empty.className = 'empty-detail';
    empty.textContent = 'Select a conversation.';
    messagesRoot.append(empty);
    return;
  }

  const messages = chatMessagesFor(active);
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-detail';
    empty.textContent = `No messages with ${active} yet.`;
    messagesRoot.append(empty);
  }
  messages.forEach((message) => {
    const block = document.createElement('div');
    block.className = 'chat-message';
    if (message.mine) block.classList.add('is-mine');
    const sender = document.createElement('strong');
    const sent = Number(message.sentAt);
    const time = Number.isFinite(sent) && sent > 0 ? new Date(sent).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    sender.textContent = `${message.sender || 'Unknown'}${time ? ` · ${time}` : ''}`;
    const body = document.createElement('p');
    body.textContent = message.body || '';
    block.append(sender, body);
    messagesRoot.append(block);
  });
  messagesRoot.scrollTop = messagesRoot.scrollHeight;
}

function updateChatNote() {
  $('#chatLocalNote').textContent = accountSession()
    ? 'Chats are delivered through the Esteria account service and sync between devices.'
    : 'Chat history persists on this PC. Sign in to your Esteria account to chat with players through the server.';
}

async function openChatDialog(friendName = null) {
  if (friendName) appState.activeChatFriend = friendName;
  const friends = socialFriends();
  if (!appState.activeChatFriend && friends.length) appState.activeChatFriend = friends[0].name;
  updateChatNote();
  $('#chatBackdrop').hidden = false;
  if (accountSession() && appState.activeChatFriend) await loadAccountThread(appState.activeChatFriend);
  renderChatDialog();
  $('#chatBackdrop').hidden = false;
}

function closeChatDialog() {
  $('#chatBackdrop').hidden = true;
}

async function sendChatMessage(event) {
  event.preventDefault();
  const body = $('#chatInput').value.trim();
  if (!body || !appState.activeChatFriend) return;
  const signature = `${appState.activeChatFriend}:${body}`;
  if (appState.chatSendAttempt?.signature !== signature) appState.chatSendAttempt = {signature, requestId: crypto.randomUUID()};
  try {
    if (accountSession()) {
      const key = appState.activeChatFriend.toLowerCase();
      const payload = await accountRequest('/api/v2/social/messages', {
        method: 'POST',
        body: { to: appState.activeChatFriend, body, requestId: appState.chatSendAttempt.requestId }
      });
      appState.accountThreads[key] = [...(appState.accountThreads[key] || []), payload.message];
      playChatSound('outgoing');
      await refreshAccountFeed({ publish: false });
    } else {
      appState.social = await invokeTauri('send_chat_message', {
        friendName: appState.activeChatFriend,
        body
      });
    }
    $('#chatInput').value = '';
    appState.chatSendAttempt = null;
    renderChatDialog();
    renderSocialPanel();
  } catch (error) {
    showToast(String(error), 5200);
  }
}

$('#profileButton').addEventListener('click', openProfileDialog);
$('#closeProfileButton').addEventListener('click', closeProfileDialog);
$('#cancelProfileButton').addEventListener('click', closeProfileDialog);
$('#saveProfileButton').addEventListener('click', saveProfile);
$('#profileBackdrop').addEventListener('click', (event) => { if (event.target === $('#profileBackdrop')) closeProfileDialog(); });
$('#socialSettingsButton').addEventListener('click', openSocialSettingsDialog);
$('#closeSocialSettingsButton').addEventListener('click', closeSocialSettingsDialog);
$('#cancelSocialSettingsButton').addEventListener('click', closeSocialSettingsDialog);
$('#saveSocialSettingsButton').addEventListener('click', saveSocialSettings);
$('#socialSettingsBackdrop').addEventListener('click', (event) => { if (event.target === $('#socialSettingsBackdrop')) closeSocialSettingsDialog(); });
$('#addFriendButton').addEventListener('click', openFriendDialog);
$('#closeFriendButton').addEventListener('click', closeFriendDialog);
$('#cancelFriendButton').addEventListener('click', closeFriendDialog);
$('#saveFriendButton').addEventListener('click', addFriendFromDialog);
$('#friendBackdrop').addEventListener('click', (event) => { if (event.target === $('#friendBackdrop')) closeFriendDialog(); });
$('#friendNameInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') addFriendFromDialog(); });
$('#chatsButton').addEventListener('click', () => openChatWindow());
$('#removeChatFriendButton').addEventListener('click', () => {
  if (appState.activeChatFriend) removeFriend(appState.activeChatFriend);
});
$('#closeChatButton').addEventListener('click', closeChatDialog);
$('#chatBackdrop').addEventListener('click', (event) => { if (event.target === $('#chatBackdrop')) closeChatDialog(); });
$('#chatForm').addEventListener('submit', sendChatMessage);
$('#accountLoginButton').addEventListener('click', () => signInAccount());
$('#accountRegisterButton').addEventListener('click', () => signInAccount({ register: true }));
$('#accountLogoutButton').addEventListener('click', signOutAccount);
$('#accountAvatarButton').addEventListener('click', uploadAccountAvatar);
$('#accountAvatarClearButton').addEventListener('click', clearAccountAvatar);
$('#accountPasswordInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') signInAccount(); });
$('#accountUsernameInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#accountPasswordInput').focus(); });
$('#friendNameInput').addEventListener('input', () => {
  clearTimeout(discoverTimer);
  discoverTimer = setTimeout(() => searchPlayers($('#friendNameInput').value.trim()), 250);
});

function channelizedManifestSource(source, channel) {
  const normalizedChannel = channel === 'ptr' ? 'ptr' : 'live';
  if (!source) return source;
  if (source.includes('{channel}')) return source.replaceAll('{channel}', normalizedChannel);
  return source.replace(/([\\/])client([\\/])(live|ptr)([\\/])manifest\.json(?=($|[?#]))/i, `$1client$2${normalizedChannel}$4manifest.json`);
}

function populateSettingsForm() {
  pathInput.value = appState.settings.gamePath || '';
  versionSelect.value = appState.settings.channel === 'ptr' ? 'ptr' : 'live';
  manifestInput.value = appState.settings.manifestSource || '';
  addonCatalogInput.value = appState.settings.addonCatalogSource || '';
  newsSourceInput.value = appState.settings.newsSource || '';
  statusSourceInput.value = appState.settings.statusSource || '';
  socialSourceInput.value = appState.settings.socialSource || '';
  accountApiInput.value = appState.settings.accountApi || DEFAULT_SETTINGS.accountApi;
  $('#gameApiInput').value = appState.settings.gameApi || '';
  $('#clientSourceInput').value = appState.settings.clientSource || '';
  $('#discordPresenceInput').checked = appState.settings.discordPresence !== false;
  armorySourceInput.value = appState.settings.armorySource || '';
  databaseSourceInput.value = appState.settings.databaseSource || '';
  patchListInput.value = appState.settings.patchList || '';
  cleanWdbInput.checked = appState.settings.cleanWdb !== false;
  closeActionSelect.value = appState.settings.closeAction || DEFAULT_SETTINGS.closeAction;
  playActionSelect.value = appState.settings.playAction || DEFAULT_SETTINGS.playAction;

  autoUpdateAddonsInput.checked = appState.settings.autoUpdateAddons !== false;
  realmHostInput.value = appState.settings.realmHost || DEFAULT_SETTINGS.realmHost;
  realmPortInput.value = appState.settings.realmPort || DEFAULT_SETTINGS.realmPort;
  if (appState.runtimeInfo?.settingsPath) {
    $('#settingsLocation').textContent = `Settings: ${appState.runtimeInfo.settingsPath}`;
  }
}

function updatePlayState() {
  const hasInstallLocation = Boolean(appState.settings.gamePath);
  const canInstall = hasInstallLocation && Boolean(appState.settings.manifestSource);
  playButton.disabled = appState.updateRunning || !hasInstallLocation || (!appState.clientInstalled && !canInstall);

  if (!hasInstallLocation) {
    playButton.textContent = 'Select Install';
  } else if (appState.needsRepair && !appState.clientInstalled) {
    playButton.textContent = 'Install';
  } else if (appState.needsRepair) {
    playButton.textContent = 'Update';
  } else if (!appState.clientInstalled) {
    playButton.textContent = 'Install';
  } else {
    playButton.textContent = 'Play';
  }
}

function setUpdateStatus(label, percent = null, detail = '') {
  updateLabel.textContent = detail ? `${label} · ${detail}` : label;
  if (percent === null) {
    updatePercent.textContent = '';
    progressFill.style.width = '0%';
    return;
  }
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  updatePercent.textContent = `${Math.round(clamped)}%`;
  progressFill.style.width = `${clamped}%`;
}

function openSettings() {
  populateSettingsForm();
  settingsBackdrop.hidden = false;
  requestAnimationFrame(() => pathInput.focus());
}
function closeSettings() {
  settingsBackdrop.hidden = true;
}

$('#openSettingsButton').addEventListener('click', openSettings);
$('#closeSettingsButton').addEventListener('click', closeSettings);
$('#cancelSettingsButton').addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', (event) => {
  if (event.target === settingsBackdrop) closeSettings();
});

$('#browseGameButton').addEventListener('click', async () => {
  if (!desktopAvailable()) {
    showToast('Folder browsing is available in the desktop launcher.');
    return;
  }
  try {
    const selected = await invokeTauri('choose_install_directory');
    if (selected) pathInput.value = selected;
  } catch (error) {
    showToast(String(error));
  }
});

$('#detectGameButton').addEventListener('click', async () => {
  try {
    const detected = await invokeTauri('detect_game_path');
    if (detected) {
      pathInput.value = detected;
      showToast('Found an existing Esteria/WoW client.');
    } else {
      showToast('No existing client was detected. Browse to an empty folder to install a new copy.');
    }
  } catch (error) {
    showToast(String(error));
  }
});

$('#openGameFolderButton').addEventListener('click', async () => {
  const settings = { ...appState.settings, gamePath: pathInput.value.trim() };
  try {
    await invokeTauri('open_install_directory', { settings });
  } catch (error) {
    showToast(String(error), 5200);
  }
});

$('#clearWdbButton').addEventListener('click', async () => {
  const settings = { ...appState.settings, gamePath: pathInput.value.trim() };
  try {
    const cleared = await invokeTauri('clear_wdb', { settings });
    showToast(cleared ? 'WDB cache cleared.' : 'WDB cache is already empty.');
  } catch (error) {
    showToast(String(error), 5200);
  }
});

versionSelect.addEventListener('change', async () => {
  const nextChannel = versionSelect.value === 'ptr' ? 'ptr' : 'live';
  if (nextChannel === appState.settings.channel) return;

  const nextManifestSource = channelizedManifestSource(appState.settings.manifestSource, nextChannel);
  if (nextManifestSource === appState.settings.manifestSource && !appState.settings.manifestSource.includes('{channel}')) {
    versionSelect.value = appState.settings.channel === 'ptr' ? 'ptr' : 'live';
    showToast('This manifest URL is not channel-aware. Use /client/live/manifest.json, /client/ptr/manifest.json, or a {channel} placeholder.');
    return;
  }

  const previousSettings = appState.settings;
  const nextSettings = {
    ...appState.settings,
    channel: nextChannel,
    manifestSource: nextManifestSource
  };

  appState.settings = nextSettings;
  appState.verification = null;
  appState.needsRepair = false;
  appState.clientInstalled = false;
  manifestInput.value = nextManifestSource;
  setUpdateStatus(`Switching to ${nextChannel === 'ptr' ? 'PTR' : 'Live'}…`);
  updatePlayState();

  try {
    const saved = await invokeTauri('save_settings', { settings: nextSettings });
    if (saved) appState.settings = saved;
    await verifyInstallation({ silent: true });
    await refreshServerStatus();
    showToast(`Switched to Esteria ${nextChannel === 'ptr' ? 'PTR' : 'Live'}.`);
  } catch (error) {
    appState.settings = previousSettings;
    versionSelect.value = previousSettings.channel === 'ptr' ? 'ptr' : 'live';
    manifestInput.value = previousSettings.manifestSource || '';
    updatePlayState();
    showToast(String(error), 5200);
  }
});

$('#saveSettingsButton').addEventListener('click', async () => {
  const port = Number.parseInt(realmPortInput.value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showToast('Realm port must be between 1 and 65535.');
    return;
  }

  const nextSettings = {
    gamePath: pathInput.value.trim(),
    channel: versionSelect.value === 'ptr' ? 'ptr' : 'live',
    manifestSource: manifestInput.value.trim(),
    addonCatalogSource: addonCatalogInput.value.trim(),
    newsSource: newsSourceInput.value.trim(),
    statusSource: statusSourceInput.value.trim(),
    socialSource: socialSourceInput.value.trim(),
    accountApi: accountApiInput.value.trim() || DEFAULT_SETTINGS.accountApi,
    gameApi: $('#gameApiInput').value.trim(),
    clientSource: $('#clientSourceInput').value.trim(),
    discordPresence: $('#discordPresenceInput').checked,
    discordClientId: appState.settings.discordClientId || '',
    armorySource: armorySourceInput.value.trim(),
    databaseSource: databaseSourceInput.value.trim(),
    autoUpdateAddons: autoUpdateAddonsInput.checked,
    realmHost: realmHostInput.value.trim() || DEFAULT_SETTINGS.realmHost,
    realmPort: port,
    patchList: patchListInput.value.trim(),
    cleanWdb: cleanWdbInput.checked,
    minimizeOnPlay: false,
    closeAction: closeActionSelect.value,
    playAction: playActionSelect.value
  };

  try {
    const saved = await invokeTauri('save_settings', { settings: nextSettings });
    appState.settings = saved || nextSettings;
    appState.verification = null;
    appState.needsRepair = false;
    appState.clientInstalled = false;
    closeSettings();
    setUpdateStatus(appState.settings.gamePath ? 'Checking install…' : 'Select install location');
    updatePlayState();
    await Promise.all([refreshRealmStatus(), refreshServerStatus(), refreshNews(), refreshSocialSnapshot()]);
    await verifyInstallation({ silent: true });
    if (appState.settings.autoUpdateAddons) await autoUpdateManagedAddons({ silent: true });
    if (appState.showingAddons) await refreshAddons();
    showToast('Launcher settings saved.');
  } catch (error) {
    showToast(String(error), 4200);
  }
});

async function refreshRealmStatus() {
  const badge = $('#realmStatus');
  const text = $('#realmStatusText');
  badge.classList.remove('is-offline');
  badge.classList.add('is-checking');
  text.textContent = 'Checking realm…';

  if (!desktopAvailable()) {
    badge.classList.remove('is-checking');
    badge.classList.add('is-offline');
    text.textContent = 'Desktop status unavailable';
    return;
  }

  try {
    const result = await invokeTauri('check_realm', { settings: appState.settings });
    badge.classList.remove('is-checking');
    badge.classList.toggle('is-offline', !result.online);
    text.textContent = result.online ? 'Realm online' : 'Realm offline';
    badge.title = `${result.host}:${result.port} · ${result.detail}`;
  } catch (error) {
    badge.classList.remove('is-checking');
    badge.classList.add('is-offline');
    text.textContent = 'Realm status unavailable';
    badge.title = String(error);
  }
}

$('#realmStatus').addEventListener('click', async () => {
  await refreshRealmStatus();
  showToast($('#realmStatusText').textContent);
});

async function verifyInstallation({ silent = false } = {}) {
  if (appState.updateRunning) return appState.verification;
  if (!appState.settings.gamePath) {
    if (!silent) {
      openSettings();
      showToast('Choose an Esteria install folder first.');
    }
    return null;
  }

  appState.updateRunning = true;
  updatePlayState();
  $('#checkUpdatesButton').disabled = true;
  setUpdateStatus('Checking game files…', 0);

  try {
    const result = await invokeTauri('verify_installation', { settings: appState.settings });
    if (!result) {
      setUpdateStatus('Desktop file check unavailable');
      return null;
    }

    appState.verification = result;
    appState.clientInstalled = Boolean(result.clientInstalled);
    appState.needsRepair = !result.upToDate;

    if (!result.manifestConfigured) {
      if (result.clientInstalled) {
        setUpdateStatus('Ready to play');
        if (!silent) showToast('Client found. Add a client manifest to enable CDN updates and repair.');
      } else {
        setUpdateStatus('Client not installed');
        if (!silent) showToast('Configure a client manifest so the launcher can install Esteria.');
      }
    } else if (result.upToDate) {
      setUpdateStatus(`Up to date · ${result.manifestVersion || 'verified'}`);
      if (!silent) showToast(`Verified ${result.checkedFiles} files. Esteria is up to date.`);
    } else {
      const broken = result.missingFiles + result.corruptFiles;
      const verb = result.clientInstalled ? 'need repair' : 'ready to install';
      setUpdateStatus(`${broken} file${broken === 1 ? '' : 's'} ${verb}`);
      if (!silent) showToast(`${broken} file${broken === 1 ? '' : 's'} need to be downloaded.`, 4200);
    }
    return result;
  } catch (error) {
    setUpdateStatus('Update check failed');
    if (!silent) showToast(String(error), 5200);
    return null;
  } finally {
    appState.updateRunning = false;
    $('#checkUpdatesButton').disabled = false;
    updatePlayState();
  }
}

async function installRequiredAddons({ silent = false } = {}) {
  if (!appState.settings.addonCatalogSource || !appState.clientInstalled) return [];
  try {
    const installed = await invokeTauri('install_required_addons', { settings: appState.settings });
    if (!silent && installed?.length) {
      showToast(`Installed ${installed.length} required add-on${installed.length === 1 ? '' : 's'}.`);
    }
    return installed || [];
  } catch (error) {
    if (!silent) showToast(String(error), 5200);
    return [];
  }
}

async function autoUpdateManagedAddons({ silent = false } = {}) {
  if (!appState.settings.autoUpdateAddons || !appState.settings.addonCatalogSource || !appState.clientInstalled) return [];
  try {
    const updated = await invokeTauri('update_managed_addons', { settings: appState.settings });
    if (!silent && updated?.length) {
      showToast(`Updated ${updated.length} managed add-on${updated.length === 1 ? '' : 's'}.`);
    }
    return updated || [];
  } catch (error) {
    if (!silent) showToast(String(error), 5200);
    else console.warn('Could not auto-update managed add-ons', error);
    return [];
  }
}

async function repairInstallation() {
  if (appState.updateRunning) return;
  if (!appState.settings.manifestSource && !appState.settings.clientSource) {
    showToast('Configure a client manifest or download link before installing or repairing Esteria.');
    openSettings();
    return;
  }

  appState.updateRunning = true;
  appState.downloadPaused = false;
  syncPauseButton();
  updatePlayState();
  $('#checkUpdatesButton').disabled = true;
  setUpdateStatus(appState.clientInstalled ? 'Preparing update…' : 'Preparing install…', 0);

  try {
    const source = await installFromClientSource();
    if (source === 'external') {
      setUpdateStatus('Waiting for your torrent client');
      return;
    }
    if (!appState.settings.manifestSource) {
      appState.clientInstalled = true;
      appState.needsRepair = false;
      setUpdateStatus('Client downloaded');
      showToast('Client downloaded.', 4200);
      return;
    }
    const result = await invokeTauri('repair_installation', { settings: appState.settings });
    if (!result) {
      showToast('Desktop updater unavailable.');
      return;
    }
    appState.clientInstalled = Boolean(result.clientInstalled);
    appState.needsRepair = !appState.clientInstalled;
    setUpdateStatus(`Updated · ${result.manifestVersion}`);
    await installRequiredAddons({ silent: true });
    await autoUpdateManagedAddons({ silent: true });
    showToast(`${appState.clientInstalled ? 'Client ready.' : 'Update complete.'} Downloaded ${result.repairedFiles} file${result.repairedFiles === 1 ? '' : 's'}.`, 4200);
  } catch (error) {
    if (String(error).includes('Download paused')) {
      appState.downloadPaused = true;
      setUpdateStatus('Paused · press Resume to continue');
    } else {
      setUpdateStatus('Update failed');
      showToast(String(error), 6500);
    }
  } finally {
    appState.updateRunning = false;
    syncPauseButton();
    $('#checkUpdatesButton').disabled = false;
    updatePlayState();
  }
}

async function registerPatchProgressListener() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  try {
    await listen('patch-progress', (event) => {
      const progress = event.payload;
      if (!progress || !appState.updateRunning) return;
      const fileName = progress.currentFile ? progress.currentFile.split(/[\\/]/).pop() : '';
      const verb = progress.phase === 'downloading'
        ? 'Downloading'
        : progress.phase === 'downloading-bundle'
          ? 'Downloading bundle'
          : progress.phase === 'installing-bundle'
            ? 'Installing bundle'
            : progress.phase === 'checking'
              ? 'Checking'
              : 'Finishing';
      let detail = '';
      if ((progress.phase === 'downloading' || progress.phase === 'downloading-bundle') && progress.bytesTotal > 0) {
        const parts = [`${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`];
        if (progress.bytesPerSecond > 0) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
        if (progress.etaSeconds) parts.push(`${formatEta(progress.etaSeconds)} left`);
        detail = parts.join(' · ');
      }
      setUpdateStatus(fileName ? `${verb} ${fileName}` : 'Finishing update…', progress.percent, detail);
    });
  } catch (error) {
    console.warn('Could not register patch progress listener', error);
  }
}

async function registerLauncherUpdateListener() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  try {
    await listen('launcher-update-progress', (event) => {
      const progress = event.payload;
      if (!progress || !appState.launcherUpdating) return;
      const detail = progress.total
        ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
        : formatBytes(progress.downloaded);
      $('#launcherUpdateText').textContent = progress.percent == null
        ? `Downloading launcher update · ${detail}`
        : `Downloading launcher update · ${progress.percent}%`;
    });
  } catch (error) {
    console.warn('Could not register launcher update listener', error);
  }
}

$('#checkUpdatesButton').addEventListener('click', async () => {
  await verifyInstallation();
  await checkLauncherUpdate();
  await refreshServerStatus();
});
$('#downloadsButton').addEventListener('click', () => {
  if (appState.updateRunning) {
    showToast(updateLabel.textContent);
  } else if (appState.verification && !appState.verification.upToDate) {
    const broken = appState.verification.missingFiles + appState.verification.corruptFiles;
    showToast(`${broken} file${broken === 1 ? '' : 's'} waiting to download.`);
  } else {
    showToast('No active downloads.');
  }
});

playButton.addEventListener('click', async () => {
  if (!appState.settings.gamePath) {
    openSettings();
    showToast('Choose an Esteria install folder first.');
    return;
  }

  if (appState.needsRepair || !appState.clientInstalled) {
    await repairInstallation();
    return;
  }

  const remembered = rememberedPlayAction();
  if (remembered === 'ask') {
    $('#playRememberInput').checked = false;
    $('#playBackdrop').hidden = false;
    return;
  }
  await startGame(remembered);
});

function renderAddons() {
  const list = $('#addonsList');
  const empty = $('#addonsEmpty');
  list.replaceChildren();

  if (!appState.settings.addonCatalogSource) {
    empty.hidden = false;
    empty.textContent = 'Configure an add-on catalog in Game settings to use the add-on manager.';
    return;
  }
  if (!appState.addons.length) {
    empty.hidden = false;
    empty.textContent = 'No add-ons are currently published in the configured catalog.';
    return;
  }
  empty.hidden = true;

  appState.addons.forEach((addon) => {
    const row = document.createElement('div');
    row.className = 'addon-row';

    const main = document.createElement('div');
    main.className = 'addon-main';
    const titleRow = document.createElement('div');
    titleRow.className = 'addon-title-row';
    const title = document.createElement('strong');
    title.textContent = addon.name;
    const version = document.createElement('span');
    version.className = 'addon-version';
    version.textContent = `v${addon.version}`;
    titleRow.append(title, version);
    if (addon.required) {
      const required = document.createElement('span');
      required.className = 'addon-required';
      required.textContent = 'Required';
      titleRow.append(required);
    }
    const meta = document.createElement('div');
    meta.className = 'addon-meta';
    meta.textContent = [addon.category, addon.author ? `by ${addon.author}` : ''].filter(Boolean).join(' · ');
    const description = document.createElement('p');
    description.textContent = addon.description || 'Managed Esteria add-on.';
    const state = document.createElement('div');
    state.className = 'addon-state';
    if (addon.updateAvailable) {
      state.textContent = `Installed ${addon.installedVersion} · update available`;
    } else if (addon.installed) {
      state.textContent = `Installed ${addon.installedVersion}`;
    } else {
      state.textContent = 'Not installed';
    }
    main.append(titleRow);
    if (meta.textContent) main.append(meta);
    main.append(description, state);

    const actions = document.createElement('div');
    actions.className = 'addon-actions';
    const primary = document.createElement('button');
    primary.className = 'primary';
    primary.textContent = addon.installed ? (addon.updateAvailable ? 'Update' : 'Reinstall') : 'Install';
    primary.disabled = appState.addonBusy || !appState.settings.gamePath;
    primary.addEventListener('click', () => installAddon(addon.id));
    actions.append(primary);

    if (addon.changelog) {
      const changes = document.createElement('button');
      changes.textContent = 'Changes';
      changes.addEventListener('click', () => showToast(addon.changelog, 6500));
      actions.append(changes);
    }

    if (addon.installed && !addon.required) {
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.disabled = appState.addonBusy;
      remove.addEventListener('click', () => removeAddon(addon.id));
      actions.append(remove);
    }

    row.append(main, actions);
    list.append(row);
  });
}

async function refreshAddons() {
  if (!appState.settings.addonCatalogSource) {
    appState.addons = [];
    renderAddons();
    return;
  }
  $('#addonsEmpty').hidden = false;
  $('#addonsEmpty').textContent = 'Loading add-on catalog…';
  try {
    const addons = await invokeTauri('list_addons', { settings: appState.settings });
    appState.addons = addons || [];
    renderAddons();
  } catch (error) {
    appState.addons = [];
    renderAddons();
    $('#addonsEmpty').hidden = false;
    $('#addonsEmpty').textContent = String(error);
  }
}

async function installAddon(addonId) {
  if (appState.addonBusy) return;
  appState.addonBusy = true;
  renderAddons();
  try {
    const result = await invokeTauri('install_addon', { settings: appState.settings, addonId });
    showToast(`${result?.name || 'Add-on'} installed.`);
    await refreshAddons();
  } catch (error) {
    showToast(String(error), 6000);
  } finally {
    appState.addonBusy = false;
    renderAddons();
  }
}

async function removeAddon(addonId) {
  if (appState.addonBusy) return;
  appState.addonBusy = true;
  renderAddons();
  try {
    await invokeTauri('remove_addon', { settings: appState.settings, addonId });
    showToast('Add-on removed.');
    await refreshAddons();
  } catch (error) {
    showToast(String(error), 6000);
  } finally {
    appState.addonBusy = false;
    renderAddons();
  }
}

async function showAddonsPage() {
  document.body.classList.remove('mode-news', 'mode-community');
  setLauncherView('addons');
  await refreshAddons();
}

$('#addonsNavButton').addEventListener('click', showAddonsPage);
$('#refreshAddonsButton').addEventListener('click', refreshAddons);
$('#closeAddonsButton').addEventListener('click', restoreMainView);
$('#installRequiredAddonsButton').addEventListener('click', async () => {
  if (appState.addonBusy) return;
  appState.addonBusy = true;
  renderAddons();
  const installed = await installRequiredAddons();
  if (!installed.length) showToast('All required add-ons are already installed.');
  appState.addonBusy = false;
  await refreshAddons();
});

function armoryMatches(character, query) {
  if (!query) return true;
  const haystack = [character.name, character.guild, character.race, character.className || character.class, character.spec, character.zone]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderArmoryDetail(character) {
  const root = $('#armoryDetail');
  root.replaceChildren();
  if (!character) {
    const empty = document.createElement('div');
    empty.className = 'empty-detail';
    empty.textContent = 'Search for a character to view their profile and equipment.';
    root.append(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'detail-header';
  const name = document.createElement('h3');
  name.textContent = character.name || 'Unknown character';
  const subtitle = document.createElement('p');
  subtitle.textContent = [character.level ? `Level ${character.level}` : '', character.race, character.className || character.class, character.spec, character.guild ? `<${character.guild}>` : '']
    .filter(Boolean)
    .join(' · ');
  header.append(name, subtitle);
  root.append(header);

  const stats = [
    ['Status', character.online ? 'Online' : 'Offline'],
    ['Zone', character.zone || 'Unknown'],
    ['Item level', character.itemLevel ?? '—'],
    ['Achievement points', character.achievementPoints ?? '—'],
    ['Guild', character.guild || 'None'],
    ['Last seen', character.online ? 'Now' : (character.lastSeen ? new Date(character.lastSeen).toLocaleString() : 'Unknown')]
  ];
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  stats.forEach(([label, value]) => {
    const stat = document.createElement('div');
    stat.className = 'detail-stat';
    const key = document.createElement('span');
    key.textContent = label;
    const data = document.createElement('strong');
    data.textContent = String(value);
    stat.append(key, data);
    grid.append(stat);
  });
  root.append(grid);

  const equipment = Array.isArray(character.equipment) ? character.equipment : [];
  if (equipment.length) {
    const list = document.createElement('div');
    list.className = 'equipment-list';
    equipment.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'equipment-row';
      const slot = document.createElement('span');
      slot.textContent = item.slot || 'Item';
      const itemName = document.createElement('strong');
      itemName.textContent = item.name || `Item ${item.id || ''}`;
      const level = document.createElement('span');
      level.textContent = item.itemLevel ? `iLvl ${item.itemLevel}` : '';
      row.append(slot, itemName, level);
      if (item.id != null) {
        row.classList.add('is-clickable');
        row.title = `Open item ${item.id} in World Database`;
        row.addEventListener('click', () => openDatabaseFor('item', String(item.id)));
      }
      list.append(row);
    });
    root.append(list);
  }
}

function renderArmory() {
  const query = $('#armorySearchInput').value.trim();
  const results = $('#armoryResults');
  results.replaceChildren();
  const filtered = (appState.armory || []).filter((character) => armoryMatches(character, query)).slice(0, 100);

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'friends-empty';
    empty.textContent = appState.armory.length ? 'No characters match this search.' : 'No armory snapshot has been published yet.';
    results.append(empty);
    renderArmoryDetail(null);
    return;
  }

  if (!appState.selectedCharacter || !filtered.some((character) => character.name === appState.selectedCharacter.name)) {
    appState.selectedCharacter = filtered[0];
  }

  filtered.forEach((character) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'result-row';
    if (appState.selectedCharacter?.name === character.name) row.classList.add('is-active');
    const title = document.createElement('strong');
    title.textContent = character.name || 'Unknown';
    const detail = document.createElement('small');
    detail.textContent = [character.level ? `Level ${character.level}` : '', character.race, character.className || character.class, character.guild].filter(Boolean).join(' · ');
    row.append(title, detail);
    row.addEventListener('click', () => {
      appState.selectedCharacter = character;
      renderArmory();
    });
    results.append(row);
  });
  renderArmoryDetail(appState.selectedCharacter);
}

async function refreshArmory() {
  if (!desktopAvailable()) return;
  try {
    const query = $('#armorySearchInput').value.trim();
    const payload = await invokeTauri('fetch_armory', { settings: appState.settings, query });
    appState.armory = Array.isArray(payload) ? payload : (Array.isArray(payload?.characters) ? payload.characters : []);
    renderArmory();
  } catch (error) {
    appState.armory = [];
    renderArmory();
    showToast(`Armory unavailable: ${serviceError(error)}`, 5200);
  }
}

function openArmoryFor(name) {
  setLauncherView('armory');
  $('#armorySearchInput').value = name || '';
  refreshArmory();
}

function databaseMatches(entry, query, type) {
  if (type !== 'all' && String(entry.type || '').toLowerCase() !== type) return false;
  if (!query) return true;
  const normalized = query.toLowerCase();
  return String(entry.id ?? '').includes(normalized) || [entry.name, entry.subtitle, entry.description, entry.type].filter(Boolean).join(' ').toLowerCase().includes(normalized);
}

function renderDatabaseDetail(entry) {
  const root = $('#databaseDetail');
  root.replaceChildren();
  if (!entry) {
    const empty = document.createElement('div');
    empty.className = 'empty-detail';
    empty.textContent = 'Select a database entry to inspect it.';
    root.append(empty);
    return;
  }
  const header = document.createElement('div');
  header.className = 'detail-header';
  const title = document.createElement('h3');
  title.textContent = entry.name || `${entry.type || 'Entry'} ${entry.id || ''}`;
  const subtitle = document.createElement('p');
  subtitle.textContent = [entry.type ? String(entry.type).toUpperCase() : '', entry.id != null ? `ID ${entry.id}` : '', entry.subtitle].filter(Boolean).join(' · ');
  header.append(title, subtitle);
  root.append(header);

  if (entry.description) {
    const description = document.createElement('p');
    description.textContent = entry.description;
    description.style.color = '#9ca5af';
    description.style.fontSize = '12px';
    description.style.lineHeight = '1.55';
    root.append(description);
  }

  const stats = Object.entries(entry)
    .filter(([key, value]) => !['name', 'subtitle', 'description', 'type'].includes(key) && value != null && ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 12);
  if (stats.length) {
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    grid.style.marginTop = '18px';
    stats.forEach(([key, value]) => {
      const stat = document.createElement('div');
      stat.className = 'detail-stat';
      const label = document.createElement('span');
      label.textContent = key.replace(/([A-Z])/g, ' $1');
      const data = document.createElement('strong');
      data.textContent = String(value);
      stat.append(label, data);
      grid.append(stat);
    });
    root.append(grid);
  }
}

function renderDatabase() {
  const query = $('#databaseSearchInput').value.trim();
  const type = $('#databaseTypeFilter').value;
  const results = $('#databaseResults');
  results.replaceChildren();
  const filtered = (appState.database || []).filter((entry) => databaseMatches(entry, query, type)).slice(0, 200);
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'friends-empty';
    empty.textContent = appState.database.length ? 'No database entries match this search.' : 'No database index has been published yet.';
    results.append(empty);
    renderDatabaseDetail(null);
    return;
  }
  if (!appState.selectedDatabaseEntry || !filtered.includes(appState.selectedDatabaseEntry)) {
    appState.selectedDatabaseEntry = filtered[0];
  }
  filtered.forEach((entry) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'result-row';
    if (entry === appState.selectedDatabaseEntry) row.classList.add('is-active');
    const title = document.createElement('strong');
    title.textContent = entry.name || `${entry.type || 'Entry'} ${entry.id || ''}`;
    const detail = document.createElement('small');
    detail.textContent = [entry.type ? String(entry.type).toUpperCase() : '', entry.id != null ? `ID ${entry.id}` : '', entry.subtitle].filter(Boolean).join(' · ');
    row.append(title, detail);
    row.addEventListener('click', () => {
      appState.selectedDatabaseEntry = entry;
      renderDatabase();
    });
    results.append(row);
  });
  renderDatabaseDetail(appState.selectedDatabaseEntry);
}

async function refreshDatabase() {
  if (!desktopAvailable()) return;
  try {
    const query = $('#databaseSearchInput').value.trim();
    const entryType = $('#databaseTypeFilter').value;
    const payload = await invokeTauri('fetch_database', { settings: appState.settings, query, entryType });
    appState.database = Array.isArray(payload) ? payload : (Array.isArray(payload?.entries) ? payload.entries : []);
    renderDatabase();
  } catch (error) {
    appState.database = [];
    renderDatabase();
    showToast(`World Database unavailable: ${serviceError(error)}`, 5200);
  }
}

function openDatabaseFor(type, query) {
  setLauncherView('database');
  $('#databaseTypeFilter').value = type || 'all';
  $('#databaseSearchInput').value = query || '';
  refreshDatabase();
}

async function refreshDiagnostics() {
  const output = $('#diagnosticsOutput');
  if (!desktopAvailable()) {
    output.textContent = 'Desktop runtime unavailable.';
    return;
  }
  try {
    const diagnostics = await invokeTauri('launcher_diagnostics', { settings: appState.settings });
    output.textContent = JSON.stringify(diagnostics, null, 2);
  } catch (error) {
    output.textContent = String(error);
  }
}

let armorySearchTimer;
let databaseSearchTimer;
$('#armorySearchInput').addEventListener('input', () => {
  renderArmory();
  clearTimeout(armorySearchTimer);
  armorySearchTimer = setTimeout(refreshArmory, 320);
});
$('#refreshArmoryButton').addEventListener('click', refreshArmory);
$('#databaseSearchInput').addEventListener('input', () => {
  renderDatabase();
  clearTimeout(databaseSearchTimer);
  databaseSearchTimer = setTimeout(refreshDatabase, 320);
});
$('#databaseTypeFilter').addEventListener('change', refreshDatabase);
$('#refreshDatabaseButton').addEventListener('click', refreshDatabase);
$('#refreshDiagnosticsButton').addEventListener('click', refreshDiagnostics);
$('#toolVerifyButton').addEventListener('click', () => verifyInstallation());
$('#toolRepairButton').addEventListener('click', () => repairInstallation());
$('#toolOpenFolderButton').addEventListener('click', async () => {
  try { await invokeTauri('open_install_directory', { settings: appState.settings }); }
  catch (error) { showToast(String(error), 5200); }
});
$('#toolClearWdbButton').addEventListener('click', async () => {
  try {
    const cleared = await invokeTauri('clear_wdb', { settings: appState.settings });
    showToast(cleared ? 'WDB cache cleared.' : 'WDB cache is already empty.');
  } catch (error) { showToast(String(error), 5200); }
});
$('#toolClearCacheButton').addEventListener('click', async () => {
  try {
    await invokeTauri('clear_launcher_cache');
    showToast('Launcher hash cache cleared. The next verification will recalculate hashes.');
    await refreshDiagnostics();
  } catch (error) { showToast(String(error), 5200); }
});
$('#toolLauncherUpdateButton').addEventListener('click', () => checkLauncherUpdate({ silent: false }));
$('#copyDiagnosticsButton').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#diagnosticsOutput').textContent || '');
    showToast('Diagnostics copied.');
  } catch (error) {
    showToast(`Could not copy diagnostics: ${String(error)}`, 4200);
  }
});
$$('[data-client-folder]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await invokeTauri('open_client_subfolder', { settings: appState.settings, folder: button.dataset.clientFolder });
    } catch (error) {
      showToast(String(error), 5200);
    }
  });
});

async function windowCommand(action) {
  try {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!appWindow) return;
    if (action === 'minimize') await appWindow.minimize();
    if (action === 'maximize') await appWindow.toggleMaximize();
    if (action === 'close') await appWindow.close();
  } catch (error) {
    console.error(error);
  }
}

$('#minimizeButton').addEventListener('click', () => windowCommand('minimize'));
$('#maximizeButton').addEventListener('click', () => windowCommand('maximize'));
$('#closeButton').addEventListener('click', () => windowCommand('close'));

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (!$('#friendContextMenu').hidden) hideFriendMenu();
  else if (!$('#closeBackdrop').hidden) $('#closeBackdrop').hidden = true;
  else if (!$('#playBackdrop').hidden) $('#playBackdrop').hidden = true;
  else if (!$('#profileCardBackdrop').hidden) closeFriendCard();
  else if (!$('#chatBackdrop').hidden) closeChatDialog();
  else if (!$('#friendBackdrop').hidden) closeFriendDialog();
  else if (!$('#socialSettingsBackdrop').hidden) closeSocialSettingsDialog();
  else if (!$('#profileBackdrop').hidden) closeProfileDialog();
  else if (!settingsBackdrop.hidden) closeSettings();
  else if (appState.activeView !== 'home') restoreMainView();
});

async function initializeDesktopState() {
  updatePlayState();
  setUpdateStatus('Loading launcher…');

  if (!desktopAvailable()) {
    appState.settings = { ...DEFAULT_SETTINGS };
    populateSettingsForm();
    setUpdateStatus('Desktop runtime required');
    updatePlayState();
    return;
  }

  try {
    const [settings, runtimeInfo] = await Promise.all([
      invokeTauri('get_settings'),
      invokeTauri('runtime_info')
    ]);
    appState.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    appState.runtimeInfo = runtimeInfo;

    if (!appState.settings.gamePath) {
      const detected = runtimeInfo?.detectedGamePath || await invokeTauri('detect_game_path');
      if (detected) {
        appState.settings.gamePath = detected;
        try {
          const saved = await invokeTauri('save_settings', { settings: appState.settings });
          if (saved) appState.settings = saved;
        } catch (error) {
          console.warn('Auto-detected path could not be persisted', error);
        }
      }
    }

    populateSettingsForm();
    if (runtimeInfo?.launcherVersion) $('#buildNumber').textContent = `Launcher ${runtimeInfo.launcherVersion}`;
    setUpdateStatus(appState.settings.gamePath ? 'Checking install…' : 'Select install location');
    updatePlayState();
    await loadSocialState();
    renderAccountPanel();
    if (accountSession()) {
      await refreshAccountFeed();
      appState.unreadByFriend = Object.fromEntries(
        (appState.accountFeed?.friends || []).map((friend) => [friend.username.toLowerCase(), Number(friend.unread) || 0])
      );
      appState.unreadTotal = Number(appState.accountFeed?.unread) || 0;
      renderSocialPanel();
    }
    if (window.__TAURI__?.event?.listen) {
      window.__TAURI__.event.listen('chat-thread', (event) => {
        appState.chatThread = event.payload?.friend || '';
      }).catch((error) => console.warn('Could not listen for chat focus changes', error));
    }
    setInterval(async () => {
      await refreshGamePresence();
      if (!accountSession()) return;
      const previousByFriend = appState.unreadByFriend || {};
      await refreshAccountFeed();
      const friends = appState.accountFeed?.friends || [];
      const nextByFriend = {};
      friends.forEach((friend) => {
        nextByFriend[friend.username.toLowerCase()] = Number(friend.unread) || 0;
      });
      appState.unreadByFriend = nextByFriend;
      appState.unreadTotal = Number(appState.accountFeed?.unread) || 0;
      const chatVisible = appState.chatWindowShown ? await chatWindowVisible() : false;
      appState.chatWindowOpen = chatVisible;
      const fresh = friends.filter(
        (friend) => (Number(friend.unread) || 0) > (previousByFriend[friend.username.toLowerCase()] || 0)
      );
      if (fresh.length) {
        playChatSound('incoming');
        const sender = fresh[0];
        const senderName = sender.displayName || sender.username;
        if (!chatVisible) {
          await openChatWindow(sender.username);
          showToast(`${senderName} sent you a message.`);
        } else if (appState.chatThread.toLowerCase() !== sender.username.toLowerCase()) {
          await requestChatAttention();
          showToast(`${senderName} sent you a message.`);
        }
      }
      renderSocialPanel();
      if (!$('#chatBackdrop').hidden && appState.activeChatFriend) {
        await loadAccountThread(appState.activeChatFriend);
        renderChatDialog();
      }
      if (appState.activeView === 'community') await refreshCommunity();
    }, 20000);
    await Promise.all([
      refreshRealmStatus(),
      refreshServerStatus(),
      refreshSocialSnapshot(),
      refreshNews(),
      checkLauncherUpdate({ silent: true })
    ]);

    if (appState.settings.gamePath) {
      setTimeout(async () => {
        await verifyInstallation({ silent: true });
        await installRequiredAddons({ silent: true });
        await autoUpdateManagedAddons({ silent: true });
      }, 350);
    }
  } catch (error) {
    setUpdateStatus('Launcher initialization failed');
    showToast(String(error), 6000);
  }
}

registerPatchProgressListener();
registerLauncherUpdateListener();
initializeDesktopState();
