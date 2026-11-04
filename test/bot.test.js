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
let priceDeleteCheck;
let registeredCommands;
const puts = [];

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
  REST.prototype.put = async (route, options) => {
    puts.push({ route, names: options.body.map((c) => c.name) });
    if (route.endsWith('/guilds/1/commands')) registeredCommands = options.body;
    return [];
  };

  require('../src/index');
  await flush();

  // El bot programa el scheduler al conectarse: nos quedamos con su funcion
  // para lanzar cada ciclo a mano en lugar de esperar 30 segundos.
  const realSetInterval = global.setInterval;
  global.setInterval = (fn, ms) => {
    if (ms === 30 * 1000) schedulerTick = fn;
    if (ms === 10 * 1000) priceDeleteCheck = fn;
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
    timers: [],
    pendingPriceDeletes: []
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

// --- Buscador de precios ---

function fakePriceSheet() {
  global.fetch = async (url) => ({
    ok: true,
    text: async () =>
      url.includes('htmlview')
        ? 'name: "Armas", pageUrl: "https:\/\/x?gid=0"'
        : ',COMPLEMENTOS,PRECIO MIN,PDB\n,Chaleco Pesado,"$40.000,00",❌\n'
  });
}

function fakeMessage(channelId, content) {
  const replies = [];
  return {
    replies,
    id: `pregunta-${content}`,
    guildId: GUILD_ID,
    channelId,
    content,
    author: { id: 'u9', bot: false },
    guild: fakeGuild(),
    attachments: { size: 0 },
    reply: async (payload) => {
      replies.push(payload);
      return { id: `respuesta-${content}` };
    }
  };
}

function setPriceChannel(channelId) {
  const state = readState();
  state.guilds[GUILD_ID].prices = { channelId, sheetId: null };
  writeState(state);
}

test('en el canal buscador el bot responde sin mencionar a nadie', async () => {
  seedGuild();
  fakePriceSheet();
  setPriceChannel('c-precios');

  const message = fakeMessage('c-precios', 'chaleco @everyone');
  client.emit(Events.MessageCreate, message);
  await flush();
  assert.equal(message.replies.length, 1);
  assert.match(message.replies[0].content, /No encontré/);
  assert.deepEqual(message.replies[0].allowedMentions.parse, []);

  const found = fakeMessage('c-precios', 'chaleco');
  client.emit(Events.MessageCreate, found);
  await flush();
  assert.match(found.replies[0].content, /Chaleco Pesado/);
  assert.match(found.replies[0].content, /\$40\.000/);
});

test('fuera del canal buscador el bot no responde', async () => {
  seedGuild();
  fakePriceSheet();
  setPriceChannel('c-precios');

  const message = fakeMessage('otro-canal', 'chaleco');
  client.emit(Events.MessageCreate, message);
  await flush();
  assert.equal(message.replies.length, 0);
});

test('quien no es admin no puede cambiar la hoja de precios', async () => {
  seedGuild();
  const interaction = fakeCommand('config_precios', {
    admin: false,
    values: { enlace: 'https://docs.google.com/spreadsheets/d/1eD_fIl9ZNro39KosscPvIjpbbjw1cMwL78ma-te3e8U/edit' }
  });
  client.emit(Events.InteractionCreate, interaction);
  await flush();
  assert.match(interaction.replies[0].content, /Solo administradores/);
  assert.equal(readState().guilds[GUILD_ID].prices.sheetId, null);
  assert.equal(registeredCommands.find((c) => c.name === 'config_precios').default_member_permissions, '8');
});

function fakeComponent(customId, { admin = true, select = false, values = [] } = {}) {
  const calls = { reply: [], update: [], editReply: [], deferUpdate: 0 };
  return {
    calls,
    customId,
    values,
    guildId: GUILD_ID,
    guild: fakeGuild(),
    channelId: 'c1',
    user: { id: 'u1', tag: 'prueba' },
    member: { permissions: { has: () => admin } },
    replied: false,
    deferred: false,
    isChatInputCommand: () => false,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => select,
    isButton: () => !select,
    isRepliable: () => true,
    reply: async (payload) => calls.reply.push(payload),
    update: async (payload) => calls.update.push(payload),
    editReply: async (payload) => calls.editReply.push(payload),
    deferUpdate: async () => {
      calls.deferUpdate += 1;
    }
  };
}

test('un admin abre el panel de precios y elige el canal', async () => {
  seedGuild();
  fakePriceSheet();

  const open = fakeComponent('main:precios');
  client.emit(Events.InteractionCreate, open);
  await flush();
  assert.match(open.calls.reply[0].content, /Buscador de precios/);
  assert.equal(open.calls.reply[0].ephemeral, true);

  const select = fakeComponent('prices:channel', { select: true, values: ['c-nuevo'] });
  client.emit(Events.InteractionCreate, select);
  await flush();
  assert.equal(readDisk().guilds[GUILD_ID].prices.channelId, 'c-nuevo');
  assert.match(select.calls.editReply[0].content, /Artículos cargados/);
  assert.equal('ephemeral' in select.calls.editReply[0], false);
});

test('el canal buscador no puede ser el de la lista de palabras', async () => {
  seedGuild();
  const state = readState();
  state.guilds[GUILD_ID].moderation.wordsChannelId = 'c-palabras';
  writeState(state);

  const select = fakeComponent('prices:channel', { select: true, values: ['c-palabras'] });
  client.emit(Events.InteractionCreate, select);
  await flush();
  assert.equal(readState().guilds[GUILD_ID].prices.channelId, null);
  assert.match(select.calls.update[0].content, /Elige otro/);
});

test('quien no es admin no puede tocar el panel de precios', async () => {
  seedGuild();
  for (const options of [
    ['main:precios', {}],
    ['prices:clear', {}],
    ['prices:channel', { select: true, values: ['c-x'] }]
  ]) {
    const interaction = fakeComponent(options[0], { admin: false, ...options[1] });
    client.emit(Events.InteractionCreate, interaction);
    await flush();
    assert.match(interaction.calls.reply[0].content, /Solo administradores/, options[0]);
  }
  assert.equal(readState().guilds[GUILD_ID].prices.channelId, null);
});

test('un servidor nuevo solo recibe el comando del buscador', async () => {
  client.emit(Events.GuildCreate, { id: 'otro-servidor', name: 'Otro' });
  await flush();
  const put = puts.find((p) => p.route.includes('/guilds/otro-servidor/'));
  assert.deepEqual(put.names, ['config_precios']);
});

test('el servidor principal conserva todos sus comandos', async () => {
  const before = puts.length;
  client.emit(Events.GuildCreate, { id: '1', name: 'Principal' });
  await flush();
  assert.equal(puts.length, before);
  assert.ok(registeredCommands.length > 5);
});

test('/config_precios sin enlace abre el panel, sin necesitar /setup', async () => {
  const interaction = fakeCommand('config_precios', { admin: true });
  client.emit(Events.InteractionCreate, interaction);
  await flush();
  assert.match(interaction.replies[0].content, /Buscador de precios/);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(readState().guilds[GUILD_ID].mainChannelId, null);
});

test('guardar una hoja nueva muestra el panel para elegir el canal', async () => {
  seedGuild();
  fakePriceSheet();
  const interaction = fakeCommand('config_precios', {
    admin: true,
    values: { enlace: 'https://docs.google.com/spreadsheets/d/1eD_fIl9ZNro39KosscPvIjpbbjw1cMwL78ma-te3e8U/edit' }
  });
  const edits = [];
  interaction.deferReply = async () => null;
  interaction.editReply = async (payload) => edits.push(payload);

  client.emit(Events.InteractionCreate, interaction);
  await flush();

  assert.match(edits[0].content, /Hoja guardada/);
  assert.match(edits[0].content, /Elige un canal/);
  assert.equal(edits[0].components.length, 2);
});

test('la busqueda y la respuesta se borran a los 2 minutos, aunque el bot se reinicie', async () => {
  seedGuild();
  fakePriceSheet();
  setPriceChannel('c-precios');

  const message = fakeMessage('c-precios', 'chaleco');
  const before = Date.now();
  client.emit(Events.MessageCreate, message);
  await flush();

  // Queda guardado en disco, no en un temporizador que se pierde al reiniciar.
  const [pending] = readDisk().pendingPriceDeletes;
  assert.deepEqual(pending.messageIds, ['pregunta-chaleco', 'respuesta-chaleco']);
  assert.ok(pending.deleteAt >= before + 2 * 60 * 1000);

  const deleted = [];
  client.channels.fetch = async () => ({
    messages: {
      delete: async (id) => {
        deleted.push(id);
      }
    }
  });

  // Antes de tiempo no borra nada.
  priceDeleteCheck();
  await flush();
  assert.deepEqual(deleted, []);

  const state = readState();
  state.pendingPriceDeletes[0].deleteAt = Date.now() - 1;
  writeState(state);
  priceDeleteCheck();
  await flush();
  assert.deepEqual(deleted, ['pregunta-chaleco', 'respuesta-chaleco']);
  assert.deepEqual(readDisk().pendingPriceDeletes, []);
});

test('si un mensaje ya no existe, borra el resto', async () => {
  const state = readState();
  state.pendingPriceDeletes.push({ channelId: 'c', messageIds: ['ya-borrado', 'otro'], deleteAt: 0 });
  writeState(state);

  const deleted = [];
  client.channels.fetch = async () => ({
    messages: {
      delete: async (id) => {
        if (id === 'ya-borrado') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        deleted.push(id);
      }
    }
  });
  priceDeleteCheck();
  await flush();
  assert.deepEqual(deleted, ['otro']);
});
