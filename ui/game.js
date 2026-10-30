// Game account, characters, screenshots, in-game presence, and download pause/resume.
// Loaded after app.js and shares its globals ($, appState, invokeTauri, showToast, accountRequest).

const GAME_SESSION_KEY = 'esteriaGameSession';
const SERVICE_FLAGS = { rename: 0x01, customize: 0x08, faction: 0x40, race: 0x80 };
const SERVICE_LABELS = { rename: 'Rename', faction: 'Faction change', race: 'Race change', customize: 'Re-customize' };

function gameEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gameSession() {
  try {
    return JSON.parse(localStorage.getItem(GAME_SESSION_KEY));
  } catch {
    return null;
  }
}

function setGameSession(session) {
  try {
    if (session) localStorage.setItem(GAME_SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(GAME_SESSION_KEY);
  } catch (error) {
    console.warn('Could not store the game session', error);
  }
}

async function gameRequest(path, { method = 'GET', body } = {}) {
  const base = String(appState.settings.gameApi || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Set the game server API address in settings first.');
  const token = gameSession()?.token;
  const response = await fetch(`${base}/launcher/v1/${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }).catch(() => {
    throw new Error(`Cannot reach the game server at ${base}. Check the Game server API address in settings and that the server's launcher module is running.`);
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 && token && path !== 'login') {
    setGameSession(null);
    renderGameAccount();
  }
  if (!response.ok) throw new Error(payload?.message || `Game server request failed (${response.status}).`);
  return payload;
}

async function gameRegister(username, password, email) {
  await gameRequest('register', { method: 'POST', body: { username, password, email } });
}

async function gameLogin(username, password) {
  const payload = await gameRequest('login', { method: 'POST', body: { username, password } });
  setGameSession({ token: payload.token, username: payload.username });
  return payload;
}

async function gameSignOut() {
  if (gameSession()) await gameRequest('logout', { method: 'POST', body: {} }).catch(() => {});
  setGameSession(null);
  appState.gamePresence = null;
  syncDiscord();
  renderGameAccount();
}

// ---- Account page -----------------------------------------------------------------------------------------------

function renderGameAccount() {
  const session = gameSession();
  $('#gameAuth').hidden = Boolean(session);
  $('#gameManage').hidden = !session;
  if (session) $('#gameAccountName').textContent = session.username;
  else if (!$('#gameUsernameInput').value) $('#gameUsernameInput').value = accountSession()?.username || '';
  renderGameLink();
}

async function refreshGameAccount() {
  renderGameAccount();
  if (!gameSession()) return;
  try {
    const [info, list] = await Promise.all([gameRequest('info'), gameRequest('characters')]);
    renderCharacters(list, info);
    if (accountSession() && !appState.accountFeed) await refreshAccountFeed().catch(() => {});
    await autoLinkGameProfile();
    renderGameLink();
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function confirmingButton(label, action) {
  const button = gameEl('button', 'field-button', label);
  button.type = 'button';
  let armed = null;
  button.addEventListener('click', async () => {
    if (armed === null) {
      button.textContent = 'Confirm?';
      armed = setTimeout(() => {
        armed = null;
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    button.textContent = label;
    button.disabled = true;
    await action();
    button.disabled = false;
  });
  return button;
}

async function gameCharacterAction(guid, action, body = {}, done = 'Done.') {
  try {
    const payload = await gameRequest(`characters/${guid}/${action}`, { method: 'POST', body });
    showToast(payload?.message || done, 5200);
  } catch (error) {
    showToast(String(error), 5200);
  }
  await refreshGameAccount();
}

const CLASS_COLORS = {
  1: '#c79c6e', 2: '#f58cba', 3: '#abd473', 4: '#fff569', 5: '#e8e8e8',
  6: '#c41f3b', 7: '#0070de', 8: '#69ccf0', 9: '#9482c9', 11: '#ff7d0a'
};
const CHAR_PAGE = 48;
const charView = { characters: [], info: {}, shown: CHAR_PAGE, mode: 'grid' };
const portraitCache = new Map(); // "raceId-gender" -> data URL, or '' when the client has none
const portraitObservers = new Map(); // grid element -> its observer

function classColor(character) {
  return CLASS_COLORS[character.classId] || '#b88a44';
}

// Fills `.char-portrait` elements that scrolled into view, asking the launcher for all missing ones in one batch.
function setupPortraitLoading(root) {
  portraitObservers.get(root)?.disconnect();
  let queue = [];
  let timer = null;
  const flush = async () => {
    timer = null;
    const batch = queue;
    queue = [];
    const need = [...new Set(batch.map((node) => node.dataset.portrait))].filter((key) => !portraitCache.has(key));
    if (need.length && appState.settings.gamePath) {
      try {
        const found = await invokeTauri('character_portraits', {
          settings: appState.settings,
          keys: need.map((key) => key.split('-').map(Number))
        });
        need.forEach((key) => portraitCache.set(key, found?.[key] || ''));
      } catch (error) {
        console.debug('Could not load portraits', error);
        need.forEach((key) => portraitCache.set(key, ''));
      }
    }
    batch.forEach((node) => paintPortrait(node));
  };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      if (portraitCache.has(entry.target.dataset.portrait)) return paintPortrait(entry.target);
      queue.push(entry.target);
      timer ??= setTimeout(flush, 60);
    });
  }, { root: $('#mainContent'), rootMargin: '300px' });
  portraitObservers.set(root, observer);
  root.querySelectorAll('.char-portrait[data-portrait]').forEach((node) => observer.observe(node));
}

function paintPortrait(node) {
  const url = portraitCache.get(node.dataset.portrait);
  if (!url) return;
  const img = gameEl('img');
  img.alt = '';
  img.src = url;
  node.prepend(img);
  node.classList.add('has-image');
}

function portraitNode(character) {
  const node = gameEl('div', 'char-portrait');
  node.style.setProperty('--class-color', classColor(character));
  node.append(gameEl('span', 'char-initial', String(character.name || '?').slice(0, 1).toUpperCase()));
  if (character.raceId) node.dataset.portrait = `${character.raceId}-${character.gender ? 1 : 0}`;
  return node;
}

function characterCard(character, info, deleted = false) {
  const card = gameEl('div', `char-card${character.online ? ' is-online' : ''}${deleted ? ' is-deleted' : ''}`);
  card.style.setProperty('--class-color', classColor(character));
  const portrait = portraitNode(character);
  portrait.append(gameEl('b', 'char-level', String(character.level)));
  card.append(portrait);

  const body = gameEl('div', 'char-body');
  body.append(gameEl('strong', 'char-name', character.name));
  body.append(gameEl('span', 'char-sub', `${character.race} ${character.class}`));
  if (deleted) {
    body.append(gameEl('span', 'char-zone', `Deleted ${new Date(character.deletedAt * 1000).toLocaleDateString()}`));
  } else {
    const where = [character.guild && `<${character.guild}>`, character.zone].filter(Boolean).join(' · ');
    if (where) body.append(gameEl('span', 'char-zone', where));
    const pending = Object.keys(SERVICE_FLAGS).filter((service) => (character.pendingService & SERVICE_FLAGS[service]) !== 0);
    const tags = gameEl('div', 'char-tags');
    if (character.online) tags.append(gameEl('i', 'tag-online', 'Online'));
    pending.forEach((service) => tags.append(gameEl('i', 'tag-pending', SERVICE_LABELS[service])));
    if (character.level >= 80) tags.append(gameEl('i', 'tag-max', 'Max level'));
    if (tags.children.length) body.append(tags);
  }
  card.append(body);

  const actions = gameEl('div', 'char-actions');
  if (deleted) {
    if (info.characterDelete) {
      const restore = gameEl('button', 'field-button', 'Restore');
      restore.type = 'button';
      restore.addEventListener('click', () => gameCharacterAction(character.guid, 'restore', {}, `${character.name} restored.`));
      actions.append(restore);
    }
  } else {
    const services = gameEl('button', 'field-button', 'Services');
    services.type = 'button';
    services.addEventListener('click', () => {
      const select = $('#gameServiceCharacter');
      select.value = String(character.guid);
      select.onchange?.();
      $('#gameServices').closest('.ga-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    actions.append(services);
    if (info.characterDelete) {
      const remove = confirmingButton('Delete', () => gameCharacterAction(character.guid, 'delete', {}, `${character.name} deleted. You can restore it below.`));
      remove.disabled = character.online;
      actions.append(remove);
    }
  }
  card.append(actions);
  return card;
}

const DAY = 86400;

function drawCharacters() {
  const { characters, info } = charView;
  const query = $('#gameCharSearch').value.trim().toLowerCase();
  const cls = $('#gameCharClass').value;
  const status = $('#gameCharStatus').value;
  const sort = $('#gameCharSort').value;
  const now = Date.now() / 1000;
  const statusOk = {
    '': () => true,
    online: (c) => c.online,
    pending: (c) => c.pendingService !== 0,
    max: (c) => c.level >= 80,
    leveling: (c) => c.level < 80,
    idle: (c) => !c.online && c.lastSeen && now - c.lastSeen > 30 * DAY,
    guilded: (c) => Boolean(c.guild)
  }[status];
  const matches = characters.filter((c) =>
    (!cls || String(c.classId) === cls) && statusOk(c) &&
    (!query || [c.name, c.race, c.class, c.zone, c.guild].some((text) => String(text || '').toLowerCase().includes(query))));
  const by = {
    level: (a, b) => b.level - a.level || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    class: (a, b) => a.class.localeCompare(b.class) || b.level - a.level,
    zone: (a, b) => (a.zone || '').localeCompare(b.zone || '') || b.level - a.level,
    created: (a, b) => a.guid - b.guid
  }[sort];
  matches.sort(by);

  const grid = $('#gameCharacters');
  grid.className = `char-grid${charView.mode === 'list' ? ' is-list' : ''}`;
  grid.replaceChildren();
  matches.slice(0, charView.shown).forEach((character) => grid.append(characterCard(character, info)));
  if (!matches.length) grid.append(gameEl('div', 'empty-detail', characters.length ? 'No characters match your filters.' : 'No characters on this account yet.'));
  const more = $('#gameCharMore');
  more.hidden = matches.length <= charView.shown;
  more.textContent = `Show more (${matches.length - charView.shown} remaining)`;
  setupPortraitLoading(grid);
}

function renderCharacterFilters() {
  const { characters } = charView;
  $('#gameCharCount').textContent = characters.length ? `(${characters.length})` : '';
  const select = $('#gameCharClass');
  const previous = select.value;
  select.replaceChildren();
  select.append(Object.assign(gameEl('option', '', 'All classes'), { value: '' }));
  [...new Map(characters.map((c) => [c.classId, c.class]))]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => select.append(Object.assign(gameEl('option', '', name), { value: String(id) })));
  select.value = previous;
}

for (const id of ['#gameCharSearch', '#gameCharClass', '#gameCharStatus', '#gameCharSort']) {
  $(id).addEventListener(id === '#gameCharSearch' ? 'input' : 'change', () => {
    charView.shown = CHAR_PAGE;
    drawCharacters();
  });
}
$('#gameCharMore').addEventListener('click', () => {
  charView.shown += CHAR_PAGE;
  drawCharacters();
});
document.querySelectorAll('[data-charview]').forEach((button) =>
  button.addEventListener('click', () => {
    charView.mode = button.dataset.charview;
    document.querySelectorAll('[data-charview]').forEach((other) => other.classList.toggle('is-active', other === button));
    drawCharacters();
  }));

function renderCharacters(list, info) {
  const characters = list.characters || [];
  Object.assign(charView, { characters, info, shown: CHAR_PAGE });
  renderCharacterFilters();
  drawCharacters();

  renderServices(characters, info);

  const deleted = $('#gameDeleted');
  deleted.replaceChildren();
  deleted.className = 'char-grid';
  (list.deleted || []).forEach((character) => deleted.append(characterCard(character, info, true)));
  setupPortraitLoading(deleted);
  if (!deleted.children.length) deleted.append(gameEl('div', 'empty-detail', 'Nothing to restore.'));
}

const SERVICE_BLURBS = {
  rename: 'Choose a new name.',
  faction: 'Switch between Alliance and Horde.',
  race: 'Change race within your faction.',
  customize: 'Change appearance: face, hair, and more.'
};

function renderServices(characters, info) {
  const select = $('#gameServiceCharacter');
  const previous = select.value;
  select.replaceChildren();
  characters.forEach((character) => {
    const option = gameEl('option', '', `${character.name} (Level ${character.level} ${character.race} ${character.class})`);
    option.value = String(character.guid);
    select.append(option);
  });
  if (characters.some((character) => String(character.guid) === previous)) select.value = previous;

  const grid = $('#gameServices');
  const draw = () => {
    grid.replaceChildren();
    const character = characters.find((entry) => String(entry.guid) === select.value);
    Object.keys(SERVICE_FLAGS).forEach((service) => {
      if (!info.services?.[service]) return;
      const pending = Boolean(character) && (character.pendingService & SERVICE_FLAGS[service]) !== 0;
      const card = gameEl('button', 'service-card');
      card.type = 'button';
      card.append(gameEl('strong', '', SERVICE_LABELS[service]));
      card.append(gameEl('span', '', pending ? 'Pending - log in to complete' : SERVICE_BLURBS[service]));
      card.disabled = !character || pending || character.online;
      card.addEventListener('click', () => gameCharacterAction(character.guid, 'service', { service }));
      grid.append(card);
    });
    if (!grid.children.length) grid.append(gameEl('div', 'empty-detail', 'This server has no character services enabled.'));
  };
  select.onchange = draw;
  draw();
}

async function gameAuthSubmit(register) {
  const username = $('#gameUsernameInput').value.trim();
  const password = $('#gamePasswordInput').value;
  const email = $('#gameEmailInput').value.trim();
  if (!username || !password) return showToast('Enter your account name and password.');
  if (register && !email) return showToast('Enter an email address to create an account.');
  try {
    if (register) await gameRegister(username, password, email);
    await gameLogin(username, password);
    $('#gamePasswordInput').value = '';
    showToast(register ? 'Game account created.' : 'Signed in to your game account.');
    await refreshGameAccount();
    refreshGamePresence();
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function gameChangeSecret(path, body, clear, done) {
  try {
    await gameRequest(path, { method: 'POST', body });
    clear.forEach((id) => ($(id).value = ''));
    showToast(done, 5200);
    return true;
  } catch (error) {
    showToast(String(error), 5200);
    return false;
  }
}

// Same name and password for the game and the Esteria social account, so a game password change has to follow.
async function changeGamePassword() {
  const current = $('#gameCurrentPasswordInput').value;
  const next = $('#gameNewPasswordInput').value;
  const changed = await gameChangeSecret('password', { current, new: next }, ['#gameCurrentPasswordInput', '#gameNewPasswordInput'], 'Game password updated.');
  if (!changed || !accountSession()) return;
  try {
    await accountRequest('/api/v2/account/password', { method: 'POST', body: { current, new: next } });
    showToast('Game and Esteria account passwords updated.', 5200);
  } catch (error) {
    showToast('Game password updated, but your Esteria social account kept its old password (it was different): ' + (error.message || error), 8000);
  }
}

$('#gameLoginButton').addEventListener('click', () => gameAuthSubmit(false));
$('#gameRegisterButton').addEventListener('click', () => gameAuthSubmit(true));
$('#gameLogoutButton').addEventListener('click', gameSignOut);
$('#refreshGameAccountButton').addEventListener('click', refreshGameAccount);
$('#gameChangePasswordButton').addEventListener('click', changeGamePassword);
$('#gameChangeEmailButton').addEventListener('click', () =>
  gameChangeSecret(
    'email',
    { password: $('#gameEmailPasswordInput').value, email: $('#gameNewEmailInput').value.trim() },
    ['#gameEmailPasswordInput', '#gameNewEmailInput'],
    'Email updated.'
  )
);

// ---- Images -----------------------------------------------------------------------------------------------------

const shotCache = new Map();
let shotObserver = null;
let shotSelected = null;
let shotList = [];
let shotMeta = {};

async function shotData(name) {
  if (!shotCache.has(name)) {
    const file = await invokeTauri('read_screenshot', { settings: appState.settings, name });
    shotCache.set(name, file);
  }
  return shotCache.get(name);
}

async function refreshImages() {
  shotList = [];
  if (appState.settings.gamePath) {
    try {
      shotList = (await invokeTauri('list_screenshots', { settings: appState.settings })) || [];
      shotMeta = (await invokeTauri('load_screenshot_meta', { settings: appState.settings })) || {};
    } catch (error) {
      showToast(String(error), 5200);
    }
  }
  renderImageGrid();
}

function shotMatches(shot, query) {
  if (!query) return true;
  const meta = shotMeta[shot.name] || {};
  return [shot.name, ...(meta.tags || []), meta.note || ''].some((text) => text.toLowerCase().includes(query));
}

function renderImageGrid() {
  const grid = $('#imageGrid');
  grid.replaceChildren();
  const query = $('#imageSearchInput').value.trim().toLowerCase();
  const shots = shotList.filter((shot) => shotMatches(shot, query));
  const empty = $('#imagesEmpty');
  empty.hidden = shots.length > 0;
  empty.textContent = shotList.length ? 'No screenshots match your search.' : 'No screenshots yet. Press Print Screen in game to take one.';
  shotObserver?.disconnect();
  shotObserver = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
      if (!entry.isIntersecting) return;
      shotObserver.unobserve(entry.target);
      try {
        const file = await shotData(entry.target.dataset.name);
        entry.target.querySelector('img').src = `data:${file.mimeType};base64,${file.dataBase64}`;
      } catch (error) {
        entry.target.querySelector('span').textContent = String(error);
      }
    });
  }, { root: $('#mainContent'), rootMargin: '200px' });
  shots.forEach((shot) => {
    const meta = shotMeta[shot.name] || {};
    const card = gameEl('button', 'image-card');
    card.type = 'button';
    card.dataset.name = shot.name;
    card.append(gameEl('img'));
    card.append(gameEl('span', '', `${shot.name} · ${new Date(shot.modified * 1000).toLocaleString()}`));
    if ((meta.tags || []).length) {
      const tags = gameEl('div', 'image-tags');
      meta.tags.forEach((tag) => tags.append(gameEl('i', '', tag)));
      card.append(tags);
    }
    card.addEventListener('click', () => openShotDialog(shot.name));
    grid.append(card);
    shotObserver.observe(card);
  });
}

async function openShotDialog(name) {
  try {
    const file = await shotData(name);
    shotSelected = file;
    const meta = shotMeta[name] || {};
    $('#shotPreview').src = `data:${file.mimeType};base64,${file.dataBase64}`;
    $('#shotNameInput').value = name.replace(/\.[^.]+$/, '');
    $('#shotTagsInput').value = (meta.tags || []).join(', ');
    $('#shotNoteInput').value = meta.note || '';
    $('#shotBodyInput').value = '';
    $('#shotBackdrop').hidden = false;
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function closeShotDialog() {
  $('#shotBackdrop').hidden = true;
  shotSelected = null;
}

async function saveShotMeta({ quiet = false } = {}) {
  if (!shotSelected) return;
  const name = shotSelected.name;
  const tags = $('#shotTagsInput').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  const note = $('#shotNoteInput').value;
  try {
    await invokeTauri('save_screenshot_meta', { settings: appState.settings, name, tags, note });
    if (tags.length || note.trim()) shotMeta[name] = { tags, note };
    else delete shotMeta[name];
    renderImageGrid();
    if (!quiet) showToast('Tags and notes saved.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function renameShot() {
  if (!shotSelected) return;
  const oldName = shotSelected.name;
  try {
    const newName = await invokeTauri('rename_screenshot', { settings: appState.settings, name: oldName, newName: $('#shotNameInput').value });
    if (newName !== oldName) {
      const file = shotCache.get(oldName);
      shotCache.delete(oldName);
      shotCache.set(newName, { ...file, name: newName });
      shotSelected = shotCache.get(newName);
      if (shotMeta[oldName]) {
        shotMeta[newName] = shotMeta[oldName];
        delete shotMeta[oldName];
      }
      const entry = shotList.find((shot) => shot.name === oldName);
      if (entry) entry.name = newName;
      renderImageGrid();
    }
    $('#shotNameInput').value = newName.replace(/\.[^.]+$/, '');
    showToast('Screenshot renamed.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

async function postShot() {
  if (!shotSelected) return;
  if (!accountSession()) return showToast('Sign in to your Esteria account (profile menu) to post.', 5200);
  try {
    await accountRequest('/api/v2/social/posts', {
      method: 'POST',
      body: { body: $('#shotBodyInput').value.trim(), mimeType: shotSelected.mimeType, dataBase64: shotSelected.dataBase64 }
    });
    closeShotDialog();
    showToast('Screenshot posted to the community feed.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

$('#refreshImagesButton').addEventListener('click', refreshImages);
$('#imageSearchInput').addEventListener('input', renderImageGrid);
$('#closeShotButton').addEventListener('click', closeShotDialog);
$('#cancelShotButton').addEventListener('click', closeShotDialog);
$('#postShotButton').addEventListener('click', postShot);
$('#renameShotButton').addEventListener('click', renameShot);
$('#saveShotMetaButton').addEventListener('click', () => saveShotMeta());

// ---- Presence ---------------------------------------------------------------------------------------------------

function gameStatusText(character) {
  return `Playing Esteria · Level ${character.level} ${character.race} · ${character.zone}`;
}

let discordSince = 0;
let discordUpdating = false;

async function syncDiscord() {
  if (discordUpdating) return;
  const settings = appState.settings;
  const character = appState.gamePresence;
  const wanted = settings.discordPresence && settings.discordClientId && appState.gameRunning;
  const details = wanted ? (character ? `Level ${character.level} ${character.race}` : 'Playing Esteria') : '';
  const state = wanted ? (character?.zone || 'In the client') : '';
  if (!wanted && !discordSince) return;
  if (wanted && !discordSince) discordSince = Math.floor(Date.now() / 1000);
  discordUpdating = true;
  try {
    await invokeTauri('set_discord_presence', {
      clientId: settings.discordClientId,
      details,
      state,
      started: wanted ? discordSince : 0
    });
    if (!wanted) discordSince = 0;
  } catch (error) {
    console.debug('Discord presence unavailable', error);
  } finally {
    discordUpdating = false;
  }
}

async function refreshGamePresence() {
  appState.gameRunning = await invokeTauri('is_game_running');
  if (!gameSession() || !appState.settings.gameApi) {
    appState.gamePresence = null;
  } else {
    try {
      const payload = await gameRequest('presence');
      appState.gamePresence = payload.online ? payload.character : null;
    } catch (error) {
      console.debug('Could not read game presence', error);
      appState.gamePresence = null;
    }
  }
  await syncDiscord();
  renderSocialPanel();
}

// ---- Download pause / resume and client source ------------------------------------------------------------------

function syncPauseButton() {
  const button = $('#pauseDownloadButton');
  button.hidden = !appState.updateRunning && !appState.downloadPaused;
  button.textContent = appState.downloadPaused ? 'Resume' : 'Pause';
}

$('#pauseDownloadButton').addEventListener('click', async () => {
  if (appState.downloadPaused) {
    await repairInstallation();
  } else if (appState.updateRunning) {
    $('#pauseDownloadButton').disabled = true;
    await invokeTauri('pause_download');
    $('#pauseDownloadButton').disabled = false;
  }
});

// Returns 'external' when the download was handed to a torrent client and the launcher should stop.
async function installFromClientSource() {
  const source = String(appState.settings.clientSource || '').trim();
  if (!source || appState.clientInstalled) return 'skipped';
  if (/^magnet:/i.test(source) || /\.torrent(\?|#|$)/i.test(source)) {
    await invokeTauri(/^magnet:/i.test(source) ? 'open_torrent_link' : 'open_external_url', { url: source });
    showToast('Opened in your torrent client. Set its download folder to your Esteria install folder, then use Verify when it finishes.', 9000);
    return 'external';
  }
  await invokeTauri('install_from_source', { settings: appState.settings });
  return 'done';
}
