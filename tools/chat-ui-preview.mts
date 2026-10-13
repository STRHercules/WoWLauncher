// Isolated UI fixture: writes no real social data and never connects to the public service.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../../EsteriaWoW/Launcher-src/server/src/social/store.js';
import { SocialService } from '../../EsteriaWoW/Launcher-src/server/src/social/service.js';
import { ChatService } from '../../EsteriaWoW/Launcher-src/server/src/social/chat.js';
import { createSocialRouter } from '../../EsteriaWoW/Launcher-src/server/src/social/routes.js';
import { Readable } from 'node:stream';
const require = createRequire(path.resolve('../EsteriaWoW/Launcher-src/server/package.json'));
const express = require('express'), sharp = require('sharp');

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-ui-preview-'));
const store = new Store(data); await store.load();
const social = new SocialService(store); const chat = social.chat = new ChatService(store, social); await chat.start();
const account = await social.register('preview', 'fixture-password', 'Preview');
await social.register('friend', 'fixture-password', 'Aelira');
const me = social.findByUsername('preview')!, friend = social.findByUsername('friend')!;
await social.requestFriend(me, 'friend'); await social.acceptFriend(friend, 'preview');
await social.sendMessage(friend, 'preview', 'The raid starts at eight.');
const image = await sharp({create: {width: 320, height: 180, channels: 4, background: '#b88a44'}}).png().toBuffer();
const attachment = await chat.upload(friend, 'dm:preview', Readable.from(image), 'image/png');
await social.sendMessage(friend, 'preview', 'Here is the map.', [attachment.id], 'fixture_map_123');
const expired = await chat.upload(friend, 'dm:preview', Readable.from(image), 'image/png');
await social.sendMessage(friend, 'preview', 'The old map expired.', [expired.id], 'fixture_old_map');
chat.state.attachments.find(a => a.id === expired.id)!.expiresAt = Date.now() - 1;
const app = express();
app.use(createSocialRouter(social, store));
let origin = '';
app.get('/chat.html', async (_req, res) => {
  const html = await fs.readFile(path.resolve('ui/chat.html'), 'utf8');
  const session = { ...account.account, token: account.token, apiBase: origin };
  const bridge = `<script>window.__TAURI__={core:{invoke:async(command)=>command==='get_social_state'?${JSON.stringify({profile: {}, account: session})}:null}};</script>`;
  res.type('html').send(html.replace('<script src="./chat-media.js">', `${bridge}<script src="./chat-media.js">`));
});
app.use(express.static(path.resolve('ui')));
const server = app.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`; console.log(`${origin}/chat.html`); });
async function stop() { chat.stop(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await fs.rm(data, {recursive: true, force: true}); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
