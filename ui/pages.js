// Community links, patch notes, the collapsible friends panel, and the social-profile <-> game-account link.
// Loaded after game.js/stats.js and shares their globals ($, appState, invokeTauri, showToast, accountRequest, gameEl, ...).

// ---- Community links ----------------------------------------------------------------------------------------------

// A link with an empty url shows as "Coming soon"; fill it in here when the page exists.
const COMMUNITY_LINKS = [
  { name: 'Discord', mark: 'D', color: '#5865f2', cta: 'Join the server', url: 'https://discord.gg/5Erpdk487X',
    blurb: 'Chat with players, find groups, get help and hear from the team first.' },
  { name: 'Reddit', mark: 'r/', color: '#ff4500', cta: 'Visit the subreddit', url: '',
    blurb: 'Guides, discussion, screenshots and theorycrafting.' },
  { name: 'X', mark: 'X', color: '#e7e9ea', cta: 'Follow on X', url: '',
    blurb: 'Short announcements and server status updates.' },
  { name: 'Bluesky', mark: 'B', color: '#1185fe', cta: 'Follow on Bluesky', url: '',
    blurb: 'News and community highlights.' },
  { name: 'YouTube', mark: '▶', color: '#ff0033', cta: 'Watch on YouTube', url: '',
    blurb: 'Trailers, showcases and community videos.' }
];

function renderCommunityLinks() {
  const grid = $('#linkCards');
  grid.replaceChildren();
  COMMUNITY_LINKS.forEach((link) => {
    const card = gameEl('button', `link-card${link.url ? '' : ' is-soon'}`);
    card.type = 'button';
    card.style.setProperty('--brand', link.color);
    card.disabled = !link.url;
    card.append(gameEl('span', 'link-mark', link.mark));
    const body = gameEl('span', 'link-body');
    body.append(gameEl('strong', '', link.name), gameEl('span', '', link.blurb));
    card.append(body, gameEl('em', '', link.url ? link.cta : 'Coming soon'));
    if (link.url) {
      card.addEventListener('click', () =>
        invokeTauri('open_external_url', { url: link.url }).catch((error) => showToast(String(error), 5200)));
    }
    grid.append(card);
  });
}

// ---- Patch notes (Markdown on the CDN) -----------------------------------------------------------------------------

const NOTE_TAGS = {
  feature: '#61c45e', content: '#a77de0', fix: '#d4a64c', hotfix: '#e0594f', server: '#4f9de0', launcher: '#d5a75f'
};
const notesView = { entries: [], tag: '' };

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escapes everything first, so only the tags produced below can reach the page.
function markdownInline(text) {
  const spans = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => `\u0000${spans.push(`<code>${code}</code>`) - 1}\u0000`);
  html = html
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext="1">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => spans[Number(index)]);
}

function markdownToHtml(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${markdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr />');
    } else if (bullet || ordered) {
      flushParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        flushList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${markdownInline((bullet || ordered)[1])}</li>`);
    } else if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${markdownInline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

// "## Title | 2026-10-27 | Tag" starts an entry; everything until the next "##" is its body.
function parsePatchNotes(markdown) {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, '');
  return text
    .split(/^##[ \t]+(?!#)/m)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf('\n');
      const head = (newline < 0 ? chunk : chunk.slice(0, newline)).split('|').map((part) => part.trim());
      const entry = { title: head[0] || 'Update', date: '', tag: '', body: newline < 0 ? '' : chunk.slice(newline + 1).trim() };
      head.slice(1).forEach((part) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(part)) entry.date = part;
        else if (part) entry.tag = part;
      });
      return entry;
    });
}

function renderPatchNotes() {
  const { entries, tag } = notesView;
  const filters = $('#patchNotesFilters');
  filters.replaceChildren();
  const tags = [...new Set(entries.map((entry) => entry.tag).filter(Boolean))];
  if (tags.length) {
    ['', ...tags].forEach((value) => {
      const chip = gameEl('button', `notes-chip${value === tag ? ' is-active' : ''}`, value || 'All');
      chip.type = 'button';
      chip.addEventListener('click', () => {
        notesView.tag = value;
        renderPatchNotes();
      });
      filters.append(chip);
    });
  }
  const list = $('#patchNotesList');
  list.replaceChildren();
  const shown = entries.filter((entry) => !tag || entry.tag === tag);
  if (!shown.length) {
    list.append(gameEl('div', 'empty-detail', entries.length ? 'No notes with that tag.' : 'No patch notes have been published yet.'));
    return;
  }
  shown.forEach((entry, index) => {
    const card = gameEl('details', 'note-card');
    card.open = index < 3;
    card.style.setProperty('--tag', NOTE_TAGS[entry.tag.toLowerCase()] || 'var(--muted-2)');
    const head = gameEl('summary', 'note-head');
    head.append(gameEl('strong', '', entry.title));
    if (entry.tag) head.append(gameEl('i', 'note-tag', entry.tag));
    if (entry.date) head.append(gameEl('time', '', new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })));
    card.append(head);
    const body = gameEl('div', 'note-body');
    body.innerHTML = markdownToHtml(entry.body); // escaped by markdownInline/escapeHtml
    card.append(body);
    list.append(card);
  });
}

async function refreshPatchNotes() {
  try {
    notesView.entries = parsePatchNotes(await invokeTauri('fetch_patch_notes', { settings: appState.settings }));
  } catch (error) {
    notesView.entries = [];
    showToast(String(error), 5200);
  }
  renderPatchNotes();
}

// Links in patch notes open in the system browser.
$('#patchNotesList').addEventListener('click', (event) => {
  const link = event.target.closest('a[data-ext]');
  if (!link) return;
  event.preventDefault();
  invokeTauri('open_external_url', { url: link.href }).catch((error) => showToast(String(error), 5200));
});

$('#linksNavButton').addEventListener('click', () => {
  document.body.classList.remove('mode-news', 'mode-community');
  setLauncherView('links');
});
$('#patchNotesNavButton').addEventListener('click', async () => {
  document.body.classList.remove('mode-news', 'mode-community');
  setLauncherView('patchnotes');
  await refreshPatchNotes();
});
$('#refreshPatchNotesButton').addEventListener('click', refreshPatchNotes);
renderCommunityLinks();

// ---- Collapsible friends panel ------------------------------------------------------------------------------------

const SOCIAL_COLLAPSED_KEY = 'esteriaSocialCollapsed';

function setSocialCollapsed(collapsed) {
  document.querySelector('.app-shell').classList.toggle('social-collapsed', collapsed);
  const toggle = $('#socialToggle');
  toggle.innerHTML = collapsed ? '&laquo;' : '&raquo;';
  toggle.title = collapsed ? 'Show friends panel' : 'Collapse friends panel';
  toggle.setAttribute('aria-label', toggle.title);
  try {
    localStorage.setItem(SOCIAL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (error) {
    console.debug('Could not remember the friends panel state', error);
  }
}

$('#socialToggle').addEventListener('click', () => setSocialCollapsed(!document.querySelector('.app-shell').classList.contains('social-collapsed')));
try {
  if (localStorage.getItem(SOCIAL_COLLAPSED_KEY) === '1') setSocialCollapsed(true);
} catch (error) {
  console.debug('Could not read the friends panel state', error);
}

// ---- Social profile <-> game account link ---------------------------------------------------------------------------
// The server stores the link permanently; it only changes when the player unlinks it here.

function setLinkedGameAccount(name) {
  if (appState.accountFeed?.me) appState.accountFeed.me.gameAccount = name;
  renderAccountPanel();
  renderGameLink();
}

async function linkGameProfile() {
  const token = gameSession()?.token;
  if (!token || !accountSession()) return;
  const payload = await accountRequest('/api/v2/account/game-link', { method: 'POST', body: { gameToken: token } });
  setLinkedGameAccount(payload?.account?.gameAccount || null);
}

// Links the first time both accounts are signed in; failures only matter when the player asks for the link.
async function autoLinkGameProfile() {
  if (!gameSession() || !accountSession() || appState.accountFeed?.me?.gameAccount) return;
  try {
    await linkGameProfile();
  } catch (error) {
    showToast(`Could not link your profile to the game account: ${error.message || error}`, 6000);
  }
}

async function unlinkGameProfile() {
  try {
    const payload = await accountRequest('/api/v2/account/game-link', { method: 'DELETE' });
    setLinkedGameAccount(payload?.account?.gameAccount || null);
    showToast('Your profile is no longer linked to a game account.');
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function renderGameLink() {
  const social = accountSession();
  const game = gameSession();
  const linked = social ? appState.accountFeed?.me?.gameAccount : null;
  const actions = $('#gameLinkActions');
  actions.replaceChildren();
  const set = (title, note) => {
    $('#gameLinkTitle').textContent = title;
    $('#gameLinkNote').textContent = note;
  };
  $('#gameLinkCard').classList.toggle('is-linked', Boolean(linked));
  if (!social) {
    set('Not signed in', 'Sign in to your Esteria account from the profile menu to link it to this game account.');
  } else if (linked) {
    const mismatch = game && String(game.username).toUpperCase() !== String(linked).toUpperCase();
    set(`@${social.username} ↔ ${linked}`, mismatch
      ? `Your profile is permanently linked to ${linked}, but you are signed in as ${game.username}. Unlink to link a different account.`
      : 'Permanently linked. Your friends see this profile as the owner of this game account.');
    actions.append(confirmingButton('Unlink', unlinkGameProfile));
  } else {
    set(`@${social.username} is not linked`, 'Link your social profile to this game account. The link is permanent until you unlink it.');
    const link = gameEl('button', 'field-button', 'Link now');
    link.type = 'button';
    link.addEventListener('click', async () => {
      try {
        await linkGameProfile();
        showToast('Profile linked to your game account.');
      } catch (error) {
        showToast(String(error.message || error), 5200);
      }
    });
    actions.append(link);
  }
}

// ---- Story reader, development feed, notifications ------------------------------------------------------------------

function shortDate(iso) {
  const date = iso ? new Date(`${iso.slice(0, 10)}T00:00:00`) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

// A story opens in the launcher when it has text; a link-only story opens in the browser.
function openStory(item) {
  const text = item.body || item.summary || '';
  if (!text) {
    if (item.url) openExternal(item.url);
    else openPatchNotes();
    return;
  }
  document.body.classList.remove('mode-news', 'mode-community');
  const image = $('#storyImage');
  image.hidden = !item.imageUrl;
  image.src = item.imageUrl || '';
  const date = item.publishedAt ? new Date(item.publishedAt) : null;
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  $('#storyMeta').textContent = [item.category || 'News', when].filter(Boolean).join(' · ');
  $('#storyTitle').textContent = item.title || 'Esteria update';
  $('#storyBody').innerHTML = markdownToHtml(text); // escaped by markdownInline/escapeHtml
  const link = $('#storyLinkButton');
  link.hidden = !item.url;
  link.onclick = () => openExternal(item.url);
  setLauncherView('story');
}

$('#storyBackButton').addEventListener('click', restoreMainView);
$('#storyBody').addEventListener('click', (event) => {
  const link = event.target.closest('a[data-ext]');
  if (!link) return;
  event.preventDefault();
  openExternal(link.href);
});

const NOTES_SEEN_KEY = 'esteriaNotesSeen';
const noteKey = (entry) => `${entry.title}|${entry.date}`;
const notesSeen = () => {
  try {
    return localStorage.getItem(NOTES_SEEN_KEY) || '';
  } catch {
    return '';
  }
};

function markNotesSeen() {
  const newest = notesView.entries[0];
  if (!newest) return;
  try {
    localStorage.setItem(NOTES_SEEN_KEY, noteKey(newest));
  } catch (error) {
    console.debug('Could not remember the last patch notes seen', error);
  }
  renderNotifications();
}

async function openPatchNotes(index = -1) {
  document.body.classList.remove('mode-news', 'mode-community');
  setLauncherView('patchnotes');
  await refreshPatchNotes();
  markNotesSeen();
  if (index >= 0) {
    const card = $('#patchNotesList').children[index];
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: 'start' });
    }
  }
}

function renderDevFeed() {
  const feed = $('#devFeed');
  feed.replaceChildren();
  const entries = notesView.entries.slice(0, 5);
  if (!entries.length) {
    feed.append(gameEl('div', 'friends-empty', 'No updates published yet.'));
    return;
  }
  entries.forEach((entry, index) => {
    const row = gameEl('button', 'feed-item');
    row.type = 'button';
    row.append(gameEl('span', 'feed-date', shortDate(entry.date) || entry.tag || ''), gameEl('span', 'feed-title', entry.title), gameEl('span', 'feed-arrow', '›'));
    row.addEventListener('click', () => openPatchNotes(index));
    feed.append(row);
  });
}

// The development feed is the newest patch-note entries.
async function refreshDevFeed() {
  try {
    notesView.entries = parsePatchNotes((await invokeTauri('fetch_patch_notes', { settings: appState.settings })) || '');
  } catch (error) {
    console.debug('Could not load the development feed', error);
    return;
  }
  renderDevFeed();
  renderNotifications();
}

$('#patchNotesNavButton').replaceWith($('#patchNotesNavButton').cloneNode(true));
$('#patchNotesNavButton').addEventListener('click', () => openPatchNotes());
$('#allGamesButton').addEventListener('click', () => $('#esteriaTabButton').click());
$('#newsViewAllButton').addEventListener('click', () => document.querySelector('.primary-nav-item[data-nav="news"]').click());

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function notificationItems() {
  const items = [];
  const update = appState.launcherUpdate;
  if (update) items.push({ title: `Launcher ${update.version} is available`, note: 'Click to download and install', run: () => installLauncherUpdate() });
  const requests = appState.accountFeed?.incoming?.length || 0;
  if (requests) items.push({ title: plural(requests, 'friend request'), note: 'Open the friends panel', run: () => setSocialCollapsed(false) });
  const unread = Number(appState.unreadTotal) || 0;
  if (unread) items.push({ title: plural(unread, 'unread message'), note: 'Open your chats', run: () => openChatDialog() });
  const newest = notesView.entries[0];
  if (newest && notesSeen() !== noteKey(newest)) items.push({ title: `New patch notes: ${newest.title}`, note: 'Read what changed', run: () => openPatchNotes(0) });
  return items;
}

function renderNotifications() {
  const items = notificationItems();
  const badge = $('#notifBadge');
  badge.hidden = !items.length;
  badge.textContent = String(items.length);
  const panel = $('#notifPanel');
  if (panel.hidden) return;
  panel.replaceChildren();
  if (!items.length) panel.append(gameEl('div', 'notif-empty', 'No new notifications'));
  items.forEach((item) => {
    const row = gameEl('button', 'notif-item');
    row.type = 'button';
    row.append(gameEl('strong', '', item.title), gameEl('span', '', item.note));
    row.addEventListener('click', () => {
      panel.hidden = true;
      $('#notifButton').setAttribute('aria-expanded', 'false');
      item.run();
    });
    panel.append(row);
  });
}

$('#notifButton').addEventListener('click', (event) => {
  event.stopPropagation();
  const panel = $('#notifPanel');
  panel.hidden = !panel.hidden;
  $('#notifButton').setAttribute('aria-expanded', String(!panel.hidden));
  renderNotifications();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.notif-wrap')) {
    $('#notifPanel').hidden = true;
    $('#notifButton').setAttribute('aria-expanded', 'false');
  }
});
setInterval(renderNotifications, 15000);
