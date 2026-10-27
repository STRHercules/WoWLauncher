// Builds catalog.json for the launcher's Add-ons page from the .zip files in a folder.
// Usage: node tools/build-addon-catalog.mjs <addonsDir> <publicBaseUrl>
//   e.g. node tools/build-addon-catalog.mjs Y:/EsteriaCDN/addons http://planetkai.hopto.org:7384/addons
// Each zip must hold its add-on folder(s) at the root (Battlemon.zip -> Battlemon/Battlemon.toc).
// Title, notes, author and version come from the .toc; edit catalog.json by hand to set category,
// required, homepage or changelog - those are kept on the next run.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, baseUrl] = process.argv.slice(2);
if (!dir || !baseUrl) {
  console.error('Usage: node tools/build-addon-catalog.mjs <addonsDir> <publicBaseUrl>');
  process.exit(1);
}

const catalogPath = path.join(dir, 'catalog.json');
const previous = new Map(
  (existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')).addons ?? [] : []).map((entry) => [entry.id, entry])
);

// bsdtar ships with Windows 10+ and reads zips, so no extra dependency is needed.
// Run from the add-ons folder with relative names: GNU tar reads "Y:\..." as a remote host.
// Git for Windows puts GNU tar (no zip support) first on PATH, so call the system bsdtar by full path.
const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
const tar = (...args) => execFileSync(tarExe, args, { cwd: dir, encoding: 'buffer', maxBuffer: 64 << 20 });
const fixText = (text) => (/\u00c3[\u0080-\u00bf]/.test(text) ? Buffer.from(text, 'latin1').toString('utf8') : text);
const plain = (text) => text.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/gi, '').trim();

const addons = [];
for (const file of readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.zip')).sort()) {
  const zip = path.join(dir, file);
  const entries = tar('-tf', file).toString('utf8').split(/\r?\n/).filter(Boolean);
  const folders = [...new Set(entries.map((entry) => entry.split('/')[0]))].filter((name) => entries.some((e) => e.startsWith(`${name}/`)));
  if (!folders.length) throw new Error(`${file} has no add-on folder at its root`);
  const tocPath = entries.find((entry) => /^[^/]+\/[^/]+\.toc$/i.test(entry));
  const toc = {};
  if (tocPath) {
    for (const line of fixText(tar('-xOf', file, tocPath).toString('utf8')).split(/\r?\n/)) {
      const match = line.match(/^##\s*([^:]+):\s*(.*)$/);
      if (match) toc[match[1].trim().toLowerCase()] = match[2].trim();
    }
  }
  const id = path.basename(file, path.extname(file)).toLowerCase();
  const old = previous.get(id) ?? {};
  addons.push({
    id,
    name: old.name ?? (plain(toc.title ?? '') || folders[0]),
    version: toc.version || old.version || '1.0.0',
    description: old.description ?? plain(toc.notes ?? ''),
    author: old.author ?? plain(toc.author ?? ''),
    category: old.category ?? 'Add-ons',
    homepage: old.homepage ?? '',
    changelog: old.changelog ?? '',
    packageUrl: `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(file)}`,
    sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
    size: statSync(zip).size,
    folders,
    required: old.required ?? false
  });
}

writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, addons }, null, 2));
console.log(`Wrote ${addons.length} add-ons to ${catalogPath}`);
addons.forEach((addon) => console.log(`  ${addon.id} ${addon.version} (${addon.folders.join(', ')}) ${(addon.size / 1048576).toFixed(2)} MB`));
