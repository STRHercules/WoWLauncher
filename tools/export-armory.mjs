// Writes armory.json for the Esteria CDN service from the AzerothCore databases (docker mysql container).
// Usage: node tools/export-armory.mjs [outFile] ; env: AC_DB_CONTAINER, AC_DB_PASSWORD, ARMORY_INCLUDE_BOTS=1
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const container = process.env.AC_DB_CONTAINER || 'ac-database';
const password = process.env.AC_DB_PASSWORD || 'password';
const out = process.argv[2] || 'G:/CDN/armory.json';
const bots = process.env.ARMORY_INCLUDE_BOTS === '1';

const query = (sql) =>
  execFileSync('docker', ['exec', container, 'mysql', `-uroot`, `-p${password}`, '-N', '-B', '--raw', '-e', sql], { encoding: 'utf8', maxBuffer: 256 << 20 })
    .split('\n').filter(Boolean).map((line) => line.split('\t'));

const CLASSES = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 6: 'Death Knight', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
const SLOTS = ['Head', 'Neck', 'Shoulder', 'Shirt', 'Chest', 'Waist', 'Legs', 'Feet', 'Wrist', 'Hands', 'Finger 1', 'Finger 2', 'Trinket 1', 'Trinket 2', 'Back', 'Main Hand', 'Off Hand', 'Ranged', 'Tabard'];

const botFilter = bots ? '' : "AND c.account NOT IN (SELECT id FROM acore_auth.account WHERE username LIKE 'RNDBOT%')";
const rows = query(`SELECT c.guid, c.name, c.level, r.Name_Lang_enUS, c.class, IFNULL(g.name,''), IFNULL(a.AreaName_Lang_enUS,''), c.online, c.logout_time
  FROM acore_characters.characters c
  LEFT JOIN acore_world.chrraces_dbc r ON r.ID = c.race
  LEFT JOIN acore_world.areatable_dbc a ON a.ID = c.zone
  LEFT JOIN acore_characters.guild_member gm ON gm.guid = c.guid
  LEFT JOIN acore_characters.guild g ON g.guildid = gm.guildid
  WHERE c.deleteDate IS NULL ${botFilter}`);

const gear = new Map();
for (const [guid, slot, id, name, quality, ilvl] of query(`SELECT ci.guid, ci.slot, it.entry, it.name, it.Quality, it.ItemLevel
  FROM acore_characters.character_inventory ci
  JOIN acore_characters.item_instance ii ON ii.guid = ci.item
  JOIN acore_world.item_template it ON it.entry = ii.itemEntry
  WHERE ci.bag = 0 AND ci.slot < 19`)) {
  if (!gear.has(guid)) gear.set(guid, []);
  gear.get(guid).push({ slot: SLOTS[+slot], id: +id, name, quality: +quality, itemLevel: +ilvl, order: +slot });
}

const points = new Map(query(`SELECT ca.guid, SUM(a.Points) FROM acore_characters.character_achievement ca
  JOIN acore_world.achievement_dbc a ON a.ID = ca.achievement GROUP BY ca.guid`));

const characters = rows.map(([guid, name, level, race, cls, guild, zone, online, logout]) => {
  const equipment = (gear.get(guid) || []).sort((a, b) => a.order - b.order).map(({ order, ...item }) => item);
  const scored = equipment.filter((item) => item.slot !== 'Shirt' && item.slot !== 'Tabard');
  return {
    name,
    level: +level,
    race: race || 'Unknown',
    className: CLASSES[cls] || 'Unknown',
    guild: guild || undefined,
    zone: zone || undefined,
    itemLevel: scored.length ? Math.round(scored.reduce((sum, item) => sum + item.itemLevel, 0) / scored.length) : 0,
    achievementPoints: +(points.get(guid) || 0),
    lastSeen: +logout ? new Date(+logout * 1000).toISOString() : undefined,
    online: online === '1',
    equipment
  };
});

writeFileSync(out, JSON.stringify({ schemaVersion: 1, characters }));
console.log(`Wrote ${characters.length} characters to ${out}`);
