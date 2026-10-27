// Stats tab: account-wide totals, breakdowns and a sortable per-character table.
// Loaded after game.js and shares its globals (gameEl, gameRequest, gameSession, classColor, DAY, ...).

const statsView = { characters: [], account: null, sort: 'level', desc: true };

function formatPlayed(seconds) {
  if (!seconds) return '';
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / 3600);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function formatGold(copper) {
  return copper >= 100 ? `${Math.floor(copper / 10000).toLocaleString()}g ${Math.floor((copper % 10000) / 100)}s` : '';
}

function formatAgo(unix) {
  if (!unix) return '';
  const days = Math.floor((Date.now() / 1000 - unix) / DAY);
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  return days < 365 ? `${Math.floor(days / 30)}mo ago` : `${(days / 365).toFixed(1)}y ago`;
}

function formatSeen(character) {
  return character.online ? 'Online' : formatAgo(character.lastSeen);
}

async function refreshStats() {
  const signedIn = Boolean(gameSession());
  $('#statsSignedOut').hidden = signedIn;
  $('#statsBody').hidden = !signedIn;
  if (!signedIn) return;
  try {
    const list = await gameRequest('characters');
    Object.assign(statsView, { characters: list.characters || [], account: list.account });
    renderStats();
  } catch (error) {
    showToast(String(error), 5200);
  }
}

function renderStats() {
  const { characters, account } = statsView;
  const stats = $('#statsTiles');
  stats.replaceChildren();
  $('#statsBreakdown').replaceChildren();
  $('#statsTableBody').replaceChildren();
  $('#statsEmpty').hidden = characters.length > 0;
  if (!characters.length) return;

  const sum = (key) => characters.reduce((total, c) => total + (c[key] || 0), 0);
  const best = (key) => characters.reduce((top, c) => ((c[key] || 0) > (top[key] || 0) ? c : top), characters[0]);
  const top = best('level');
  const mostPlayed = best('playedSeconds');
  const richest = best('money');
  const seen = Math.max(0, ...characters.map((c) => c.lastSeen || 0));
  const tally = (key) => characters.reduce((map, c) => map.set(c[key], (map.get(c[key]) || 0) + 1), new Map());
  const playedByClass = characters.reduce((map, c) => map.set(c.class, (map.get(c.class) || 0) + (c.playedSeconds || 0)), new Map());
  const favourite = [...playedByClass].sort((a, b) => b[1] - a[1])[0];
  const guilds = new Set(characters.map((c) => c.guild).filter(Boolean));
  [
    [characters.length, 'Characters'],
    [formatPlayed(sum('playedSeconds')) || '-', 'Total time played'],
    [formatGold(sum('money')) || '-', 'Total gold'],
    [characters.filter((c) => c.level >= 80).length, 'At max level'],
    [Math.round(sum('level') / characters.length), 'Average level'],
    [tally('classId').size, 'Classes played'],
    [tally('raceId').size, 'Races played'],
    [sum('kills').toLocaleString(), 'Honorable kills'],
    [sum('achievements').toLocaleString(), 'Achievements earned'],
    [sum('honor').toLocaleString(), 'Honor points'],
    [sum('arena').toLocaleString(), 'Arena points'],
    [guilds.size, 'Guilds'],
    [characters.filter((c) => c.online).length, 'Online now'],
    [top.name, `Highest level · ${top.level}`],
    [mostPlayed.playedSeconds ? mostPlayed.name : '-', `Most played · ${formatPlayed(mostPlayed.playedSeconds) || '-'}`],
    [richest.money >= 100 ? richest.name : '-', `Richest · ${formatGold(richest.money) || '-'}`],
    [favourite && favourite[1] ? favourite[0] : '-', 'Most-played class'],
    [account?.joined ? new Date(account.joined * 1000).toLocaleDateString() : '-', `Account created${account?.joined ? ` · ${formatAgo(account.joined)}` : ''}`],
    [seen ? formatAgo(seen) : '-', 'Last character seen']
  ].forEach(([value, label]) => {
    const tile = gameEl('div', 'char-stat');
    tile.append(gameEl('strong', '', String(value)), gameEl('span', '', label));
    stats.append(tile);
  });

  const breakdown = $('#statsBreakdown');
  const bars = (title, map, colorOf) => {
    const column = gameEl('div', 'char-bars');
    column.append(gameEl('h4', '', title));
    const most = Math.max(...map.values());
    [...map].sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
      const row = gameEl('div', 'char-bar');
      const fill = gameEl('i');
      fill.style.width = `${(count / most) * 100}%`;
      fill.style.background = colorOf(name);
      row.append(gameEl('span', '', name), fill, gameEl('b', '', String(count)));
      column.append(row);
    });
    breakdown.append(column);
  };
  const colorByClass = new Map(characters.map((c) => [c.class, classColor(c)]));
  bars('By class', tally('class'), (name) => colorByClass.get(name) || '#b88a44');
  bars('By race', tally('race'), () => 'var(--accent)');
  const levels = new Map();
  characters.forEach((c) => {
    const band = c.level >= 80 ? '80' : `${Math.floor(c.level / 10) * 10}-${Math.floor(c.level / 10) * 10 + 9}`;
    levels.set(band, (levels.get(band) || 0) + 1);
  });
  bars('By level', levels, () => 'var(--accent-strong)');

  drawStatsTable();
}

const STATS_COLUMNS = [
  { key: 'name', label: 'Character', text: true, value: (c) => c.name },
  { key: 'level', label: 'Level', value: (c) => c.level },
  { key: 'class', label: 'Class', text: true, value: (c) => c.class },
  { key: 'playedSeconds', label: 'Played', value: (c) => c.playedSeconds || 0, show: (c) => formatPlayed(c.playedSeconds) || '-' },
  { key: 'money', label: 'Gold', value: (c) => c.money || 0, show: (c) => formatGold(c.money) || '-' },
  { key: 'kills', label: 'HKs', value: (c) => c.kills || 0, show: (c) => (c.kills || 0).toLocaleString() },
  { key: 'achievements', label: 'Achievements', value: (c) => c.achievements || 0 },
  { key: 'honor', label: 'Honor', value: (c) => c.honor || 0, show: (c) => (c.honor || 0).toLocaleString() },
  { key: 'arena', label: 'Arena', value: (c) => c.arena || 0 },
  { key: 'lastSeen', label: 'Last seen', value: (c) => (c.online ? Infinity : c.lastSeen || 0), show: (c) => formatSeen(c) || '-' },
  { key: 'guild', label: 'Guild', text: true, value: (c) => c.guild || '' }
];

function drawStatsTable() {
  const column = STATS_COLUMNS.find((entry) => entry.key === statsView.sort) || STATS_COLUMNS[1];
  const direction = statsView.desc ? -1 : 1;
  const rows = [...statsView.characters].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    const order = column.text ? String(left).localeCompare(String(right)) : (left === right ? 0 : left < right ? -1 : 1);
    return order * direction || a.name.localeCompare(b.name);
  });

  const head = $('#statsTableHead');
  head.replaceChildren();
  const tr = gameEl('tr');
  STATS_COLUMNS.forEach((entry) => {
    const th = gameEl('th', entry.key === column.key ? 'is-sorted' : '', entry.label + (entry.key === column.key ? (statsView.desc ? ' ▾' : ' ▴') : ''));
    th.addEventListener('click', () => {
      statsView.desc = statsView.sort === entry.key ? !statsView.desc : !entry.text;
      statsView.sort = entry.key;
      drawStatsTable();
    });
    tr.append(th);
  });
  head.append(tr);

  const body = $('#statsTableBody');
  body.replaceChildren();
  rows.forEach((character) => {
    const row = gameEl('tr');
    STATS_COLUMNS.forEach((entry) => {
      const cell = gameEl('td', '', entry.show ? entry.show(character) : String(entry.value(character) || '-'));
      if (entry.key === 'name' || entry.key === 'class') cell.style.color = classColor(character);
      row.append(cell);
    });
    body.append(row);
  });
}

$('#refreshStatsButton').addEventListener('click', refreshStats);
