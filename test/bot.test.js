// Prueba el bot real (src/index.js) con Discord simulado: nunca se conecta.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
// dotenv no sobrescribe variables ya definidas, asi que el .env real no se usa.
Object.assign(process.env, {
  DISCORD_TOKEN: 'token-de-prueba',
  CLIENT_ID: '1',
  GUILD_ID: '1',
  DATA_DIR: dataDir,
  WEB_URL: '',
  WEB_BOT_SECRET: ''
});

const { Client, Events, REST } = require('discord.js');
const { readState, writeState } = require('../src/storage');

const STATE_FILE = path.join(dataDir, 'state.json');
const GUILD_ID = 'g1';

let client;
let schedulerTick;
let registeredCommands;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Da tiempo a que terminen las promesas pendientes del bot.
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function readDisk() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function fakeGuild() {
  return {
    id: GUILD_ID,
    name: 'Servidor de prueba',
    ownerId: 'dueno',
    channels: { fetch: async () => null }
  };
}

function fakeCommand(commandName, { admin = false, userId = 'u1', values = {}, reply } = {}) {
  return {
    commandName,
    guildId: GUILD_ID,
    guild: fakeGuild(),
    channel: { id: 'canal-nuevo' },
    channelId: 'canal-nuevo',
    user: { id: userId, tag: 'prueba' },
    member: { permissions: { has: () => admin } },
    options: {
      getString: (name) => values[name] ?? null,
      getChannel: (name) => values[name] ?? null
    },
    replies: [],
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    reply:
      reply ||
      async function (payload) {
        this.replies.push(payload);
      }
  };
}

before(async () => {
  Client.prototype.login = async function () {
    client = this;
    return 'token';
  };
  REST.prototype.put = async (_route, options) => {
    registeredCommands = options.body;
    return [];
  };

  require('../src/index');
  await flush();

  // El bot programa el scheduler al conectarse: nos quedamos con su funcion
  // para lanzar cada ciclo a mano en lugar de esperar 30 segundos.
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    if (ms === 30 * 1000) schedulerTick = fn;
    return { unref() {} };
  };
  client.emit(Events.ClientReady, { user: { tag: 'bot', id: '1' }, guilds: { fetch: async () => null } });
  await flush();
  global.setInterval = realSetInterval;
  assert.ok(schedulerTick, 'el scheduler deberia haberse programado');
});

after(async () => {
  await client.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Vacia el estado compartido y deja un servidor configurado.
beforeEach(() => {
  const state = readState();
  Object.assign(state, {
    guilds: {},
    tasks: {},
    reports: [],
    pendingEvidence: {},
    pendingPlantation: {},
    timers: []
  });
  writeState(state);
  client.guilds.fetch = async () => fakeGuild();
  client.users.fetch = async () => null;
});

// Crea el servidor en el estado guardado usando un comando que escribe en disco.
function seedGuild() {
  client.emit(Events.InteractionCreate, fakeCommand('cd', { values: { tiempo: '1h' } }));
  const state = readState();
  state.timers = [];
  writeState(state);
  assert.ok(readDisk().guilds[GUILD_ID], 'el servidor deberia estar guardado');
}

test('un /cd creado durante un ciclo lento del scheduler no se pierde', async () => {
  seedGuild();
  await flush();

  const slowDiscord = deferred();
  client.guilds.fetch = () => slowDiscord.promise;
  schedulerTick();
  await flush();

  client.emit(
    Events.InteractionCreate,
    fakeCommand('cd', { values: { tiempo: '2h', nombre: 'Durante el ciclo' } })
  );
  await flush();

  slowDiscord.resolve(fakeGuild());
  await flush();

  assert.deepEqual(readDisk().timers.map((t) => t.label), ['Durante el ciclo']);
});

test('una mision registrada mientras se avisa de otra terminada no se pierde', async () => {
  seedGuild();
  await flush();

  const state = readState();
  state.tasks[GUILD_ID] = {
    maritimeTerrestrial: [
      { id: 'vencida', type: 'maritimo', userId: 'u1', cooldownHours: 24, endsAt: Date.now() - 1000 }
    ],
    plantation: []
  };
  state.pendingEvidence[`${GUILD_ID}:u2`] = {
    guildId: GUILD_ID,
    userId: 'u2',
    channelId: 'c1',
    taskType: 'terrestre',
    cooldownHours: 8,
    createdAt: Date.now()
  };
  writeState(state);

  const slowDm = deferred();
  client.users.fetch = () => slowDm.promise;
  schedulerTick();
  await flush();

  client.emit(Events.MessageCreate, {
    guildId: GUILD_ID,
    channelId: 'c1',
    author: { id: 'u2', bot: false },
    guild: fakeGuild(),
    attachments: {
      size: 1,
      first: () => ({ contentType: 'image/png', name: 'a.png', url: 'http://x/a.png' })
    },
    reply: async () => null
  });
  await flush();

  slowDm.resolve(null);
  await flush();

  const missions = readDisk().tasks[GUILD_ID].maritimeTerrestrial;
  assert.deepEqual(missions.map((t) => t.userId), ['u2']);
});

test('un reply fallido en un comando no tumba el bot y se intenta avisar', async () => {
  let attempts = 0;
  const interaction = fakeCommand('estado', {
    reply: async () => {
      attempts += 1;
      throw new Error('Unknown interaction');
    }
  });

  client.emit(Events.InteractionCreate, interaction);
  await flush();

  // El intento original y el aviso de error.
  assert.equal(attempts, 2);
});

test('un reply fallido al procesar un mensaje no tumba el bot', async () => {
  seedGuild();
  await flush();
  const state = readState();
  state.pendingPlantation[`${GUILD_ID}:u1`] = {
    channelId: 'c1',
    type: 'ramas',
    createdAt: Date.now()
  };
  writeState(state);

  let replied = false;
  client.emit(Events.MessageCreate, {
    guildId: GUILD_ID,
    channelId: 'c1',
    content: 'no es un numero',
    author: { id: 'u1', bot: false },
    guild: fakeGuild(),
    attachments: { size: 0 },
    reply: async () => {
      replied = true;
      throw new Error('Missing Permissions');
    }
  });
  await flush();

  assert.equal(replied, true);
});

test('/setup y /asignar_canal se ocultan por defecto a quien no es admin', () => {
  for (const name of ['setup', 'asignar_canal']) {
    const command = registeredCommands.find((c) => c.name === name);
    assert.equal(command.default_member_permissions, '8', name);
  }
});

test('quien no es admin no puede usar /setup', async () => {
  seedGuild();
  await flush();

  const interaction = fakeCommand('setup', { admin: false });
  client.emit(Events.InteractionCreate, interaction);
  await flush();

  assert.match(interaction.replies[0].content, /Solo administradores/);
  assert.equal(readState().guilds[GUILD_ID].mainChannelId, null);
});

test('quien no es admin no puede usar /asignar_canal', async () => {
  seedGuild();
  await flush();
  const before = JSON.stringify(readState().guilds[GUILD_ID]);

  const interaction = fakeCommand('asignar_canal', {
    admin: false,
    values: { tarea: 'runs', canal: { id: 'canal-ajeno' } }
  });
  client.emit(Events.InteractionCreate, interaction);
  await flush();

  assert.match(interaction.replies[0].content, /Solo administradores/);
  assert.equal(JSON.stringify(readState().guilds[GUILD_ID]), before);
});

test('un admin y el dueno del servidor si pueden usar /setup', async () => {
  const asAdmin = fakeCommand('setup', { admin: true });
  client.emit(Events.InteractionCreate, asAdmin);
  await flush();
  assert.equal(readState().guilds[GUILD_ID].mainChannelId, 'canal-nuevo');
  assert.doesNotMatch(asAdmin.replies[0].content, /Solo administradores/);

  const asOwner = fakeCommand('setup', { admin: false, userId: 'dueno' });
  client.emit(Events.InteractionCreate, asOwner);
  await flush();
  assert.doesNotMatch(asOwner.replies[0].content, /Solo administradores/);
});
