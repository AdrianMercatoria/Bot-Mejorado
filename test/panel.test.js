// Prueba el tablero del Panel de Administracion con Discord simulado.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-panel-'));
Object.assign(process.env, {
  DISCORD_TOKEN: 'token-de-prueba',
  CLIENT_ID: '1',
  GUILD_ID: '1',
  DATA_DIR: dataDir,
  WEB_URL: '',
  WEB_BOT_SECRET: ''
});

const { Client, Events, MessageFlags, REST } = require('discord.js');
const { readState, writeState } = require('../src/storage');

const GUILD_ID = 'g1';
const V2 = MessageFlags.IsComponentsV2;

let client;
let schedulerTick;
let channel;

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

// Canal simulado que recuerda lo que se publica, edita y borra.
function fakeChannel() {
  const fake = {
    id: 'main',
    type: 0,
    messages_: new Map(),
    sent: [],
    edits: [],
    deleted: [],
    newerExists: false,
    failSend: false,
    isTextBased: () => true,
    send: async (payload) => {
      if (fake.failSend) throw new Error('Invalid Form Body');
      const message = fake.addMessage(`m${fake.sent.length + 1}`, payload.flags);
      fake.sent.push(payload);
      return message;
    },
    addMessage: (id, flags = 0) => {
      const message = {
        id,
        flags: { has: (flag) => (flags & flag) !== 0 },
        edit: async (payload) => {
          fake.edits.push(payload);
          return message;
        },
        delete: async () => {
          fake.deleted.push(id);
        }
      };
      fake.messages_.set(id, message);
      return message;
    },
    messages: {
      fetch: async (query) => {
        if (typeof query === 'string') return fake.messages_.get(query) || null;
        return { size: fake.newerExists ? 1 : 0 };
      }
    }
  };
  return fake;
}

function fakeGuild() {
  return { id: GUILD_ID, name: 'Prueba', ownerId: 'dueno', channels: { fetch: async () => channel } };
}

function fakeButton(customId, { admin = true } = {}) {
  const replies = [];
  return {
    replies,
    customId,
    guildId: GUILD_ID,
    guild: fakeGuild(),
    user: { id: 'u1', tag: 'prueba' },
    member: { permissions: { has: () => admin } },
    replied: false,
    deferred: false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isButton: () => true,
    isRepliable: () => true,
    reply: async (payload) => replies.push(payload)
  };
}

// Reune los customId y textos de un tablero publicado.
function describePanel(payload) {
  const ids = [];
  const texts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.custom_id) ids.push(node.custom_id);
    if (typeof node.content === 'string') texts.push(node.content);
    Object.values(node).forEach(walk);
  };
  walk(payload.components.map((component) => component.toJSON()));
  return { ids, text: texts.join('\n') };
}

async function tick() {
  schedulerTick();
  await flush();
}

before(async () => {
  Client.prototype.login = async function () {
    client = this;
    return 'token';
  };
  REST.prototype.put = async () => [];

  require('../src/index');
  await flush();

  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    if (ms === 30 * 1000) schedulerTick = fn;
    return { unref() {} };
  };
  client.emit(Events.ClientReady, { user: { tag: 'bot', id: '1' }, guilds: { fetch: async () => null } });
  await flush();
  global.setInterval = realSetInterval;
});

after(async () => {
  await client.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  channel = fakeChannel();
  client.guilds.fetch = async () => fakeGuild();
  client.users.fetch = async () => null;

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

  // Crea el servidor con sus valores por defecto usando un boton real.
  client.emit(Events.InteractionCreate, fakeButton('main:manage:runs'));
  await flush();
  readState().guilds[GUILD_ID].mainChannelId = 'main';
});

test('publica el tablero con los botones de todas las funciones', async () => {
  await tick();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].flags, V2);
  assert.deepEqual(channel.sent[0].allowedMentions.parse, []);

  const { ids } = describePanel(channel.sent[0]);
  assert.deepEqual(ids.sort(), [
    'main:canales',
    'main:estado',
    'main:list-evidence',
    'main:manage:maritimo_terrestre',
    'main:manage:runs',
    'main:moderacion',
    'main:precios',
    'main:stats',
    'main:vender-toggle'
  ]);
});

test('muestra el estado real de cada mision', async () => {
  const state = readState();
  const guild = state.guilds[GUILD_ID];
  const cooldownEndsAt = Date.now() + 60 * 60 * 1000;
  guild.runsChannelId = 'c-runs';
  guild.runs.status = 'cooldown';
  guild.runs.cooldownEndsAt = cooldownEndsAt;
  state.tasks[GUILD_ID] = {
    maritimeTerrestrial: [
      { id: 'a', endsAt: Date.now() + 1000000 },
      { id: 'b', endsAt: Date.now() + 2000000 }
    ],
    plantation: [{ id: 'p', status: 'in_progress' }, { id: 'q', status: 'finished' }]
  };
  state.pendingEvidence[`${GUILD_ID}:u1`] = { guildId: GUILD_ID, createdAt: Date.now() };
  state.pendingEvidence['otro:u2'] = { guildId: 'otro', createdAt: Date.now() };
  writeState(state);

  await tick();
  const { text } = describePanel(channel.sent.find((payload) => payload.flags === V2));
  assert.match(text, /🟡 \*\*RUNS\*\*/);
  assert.match(text, new RegExp(`disponible <t:${Math.floor(cooldownEndsAt / 1000)}:R>`));
  assert.match(text, /<#c-runs>/);
  assert.match(text, /2 en CD/);
  assert.match(text, /1 por enviar/);
  assert.match(text, /🔴 \*\*Vender\*\*/);
  assert.doesNotMatch(text, /Plantaci/);
});

test('el boton de Vender cambia segun su estado', async () => {
  readState().guilds[GUILD_ID].vender.active = true;
  await tick();
  const [container] = channel.sent[0].components;
  const json = JSON.stringify(container.toJSON());
  assert.match(json, /"label":"Detener"/);
  assert.doesNotMatch(json, /"label":"Iniciar"/);
});

test('si nada cambia no edita el mensaje en cada ciclo', async () => {
  await tick();
  await tick();
  await tick();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.edits.length, 0);
});

test('si cambia el estado edita el mismo mensaje', async () => {
  await tick();
  readState().guilds[GUILD_ID].runs.status = 'in_progress';
  await tick();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.edits.length, 1);
  assert.match(describePanel(channel.edits[0]).text, /🟢|⚪/);
});

test('con mensajes mas nuevos vuelve a publicarlo al final', async () => {
  await tick();
  channel.newerExists = true;
  await tick();
  assert.equal(channel.sent.length, 2);
  assert.deepEqual(channel.deleted, ['m1']);
  assert.equal(readState().guilds[GUILD_ID].adminPanelRef.messageId, 'm2');
});

test('sustituye el panel antiguo por el tablero', async () => {
  channel.addMessage('antiguo', 0);
  readState().guilds[GUILD_ID].adminPanelRef = { channelId: 'main', messageId: 'antiguo' };

  await tick();

  assert.equal(channel.edits.length, 0);
  assert.equal(channel.sent.length, 1);
  assert.deepEqual(channel.deleted, ['antiguo']);
  assert.equal(readState().guilds[GUILD_ID].adminPanelRef.messageId, 'm1');
});

test('si Discord rechaza el tablero, el panel antiguo no se borra', async () => {
  channel.addMessage('antiguo', 0);
  readState().guilds[GUILD_ID].adminPanelRef = { channelId: 'main', messageId: 'antiguo' };
  channel.failSend = true;

  await tick();

  assert.deepEqual(channel.deleted, []);
  assert.equal(readState().guilds[GUILD_ID].adminPanelRef.messageId, 'antiguo');
});

test('Gestionar abre en privado las acciones de esa mision', async () => {
  const interaction = fakeButton('main:manage:runs');
  readState().guilds[GUILD_ID].runsChannelId = 'c-runs';
  client.emit(Events.InteractionCreate, interaction);
  await flush();

  const [reply] = interaction.replies;
  assert.equal(reply.ephemeral, true);
  assert.match(reply.content, /RUNS/);
  const buttons = reply.components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.custom_id), ['main:regen-panel:runs', 'main:clean:runs']);
  assert.ok(buttons.every((b) => !b.disabled));
});

test('sin canal asignado, Gestionar no deja recrear ni limpiar', async () => {
  const interaction = fakeButton('main:manage:runs');
  client.emit(Events.InteractionCreate, interaction);
  await flush();
  const buttons = interaction.replies[0].components[0].toJSON().components;
  assert.ok(buttons.every((b) => b.disabled));
  assert.match(interaction.replies[0].content, /\/asignar_canal/);
});

test('quien no es admin no puede usar Gestionar', async () => {
  const interaction = fakeButton('main:manage:runs', { admin: false });
  client.emit(Events.InteractionCreate, interaction);
  await flush();
  assert.match(interaction.replies[0].content, /Solo administradores/);
  assert.equal(interaction.replies[0].components, undefined);
});

test('una mision desconocida no rompe Gestionar', async () => {
  const interaction = fakeButton('main:manage:inventada');
  client.emit(Events.InteractionCreate, interaction);
  await flush();
  assert.match(interaction.replies[0].content, /no soportado/);
});
