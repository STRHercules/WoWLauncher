import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../ui/game.js', import.meta.url), 'utf8');
const presence = source.slice(source.indexOf('let discordSince = 0;'), source.indexOf('// ---- Download pause'));

function fixture({ session = null, online = true, request = async () => null, send = async () => {} } = {}) {
  const calls = [];
  const appState = { settings: { discordPresence: true, discordClientId: '123', gameApi: 'http://game' } };
  const context = vm.createContext({
    appState,
    console: { debug() {} },
    gameSession: () => session,
    gameRequest: request,
    renderSocialPanel() {},
    invokeTauri: async (command, args) => {
      if (command === 'is_game_running') return online;
      assert.equal(command, 'set_discord_presence');
      calls.push(args);
      await send(args);
    }
  });
  vm.runInContext(presence, context);
  return { context, appState, calls };
}

test('a running client gets activity without a game account login', async () => {
  const { context, calls } = fixture();
  await context.refreshGamePresence();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].details, 'Playing Esteria');
  assert.equal(calls[0].state, 'In the client');
  assert.ok(calls[0].started > 0);
});

test('unchanged activity reconnects after a failed connection', async () => {
  let attempts = 0;
  const { context, appState, calls } = fixture({ send: async () => {
    if (++attempts === 2) throw new Error('Discord restarted');
  } });
  appState.gameRunning = true;
  await context.syncDiscord();
  await context.syncDiscord();
  await context.syncDiscord();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].started, calls[1].started);
});

test('character details enhance activity and client exit clears it', async () => {
  const { context, appState, calls } = fixture();
  appState.gameRunning = true;
  await context.syncDiscord();
  appState.gamePresence = { level: 72, race: 'Vrykul', zone: 'Elwynn Forest' };
  await context.syncDiscord();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].details, 'Level 72 Vrykul');
  assert.equal(calls[1].state, 'Elwynn Forest');
  appState.gameRunning = false;
  await context.syncDiscord();
  assert.equal(calls[2].details, '');
  assert.equal(calls[2].started, 0);
});

test('activity survives a game API failure and respects the disabled setting', async () => {
  const { context, appState, calls } = fixture({ session: { token: 'fixture' }, request: async () => {
    throw new Error('Game API unavailable');
  } });
  await context.refreshGamePresence();
  assert.equal(calls[0].details, 'Playing Esteria');
  appState.settings.discordPresence = false;
  await context.syncDiscord();
  assert.equal(calls[1].details, '');
});

test('a stopped client does not publish stale character activity', async () => {
  const { context, calls } = fixture({ online: false, session: { token: 'fixture' }, request: async () => ({
    online: true, character: { level: 72, race: 'Vrykul', zone: 'Elwynn Forest' }
  }) });
  await context.refreshGamePresence();
  assert.equal(calls.length, 0);
});
