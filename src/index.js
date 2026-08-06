require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const { readState, writeState } = require('./storage');
const { addHours, formatDuration } = require('./time');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const missingVars = [];
if (!DISCORD_TOKEN) missingVars.push('DISCORD_TOKEN');
if (!CLIENT_ID) missingVars.push('CLIENT_ID');

if (missingVars.length > 0) {
  console.error(
    `\n[ERROR] Faltan las siguientes variables de entorno obligatorias:\n` +
    missingVars.map((v) => `  - ${v}`).join('\n') +
    `\n\nCrea un archivo .env en la raíz del proyecto (básate en .env.example) y completa los valores.\nEl bot no puede iniciar sin estas variables.\n`
  );
  process.exit(1);
}

if (!GUILD_ID) {
  console.warn(
    '[AVISO] GUILD_ID no está configurado. Los slash commands se registrarán de forma global.\n' +
    '        La propagación global puede tardar hasta 1 hora en reflejarse en Discord.\n' +
    '        Para pruebas rápidas, agrega GUILD_ID=<id_de_tu_servidor> en tu .env\n'
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configura el canal Main y crea paneles de control'),
  new SlashCommandBuilder()
    .setName('estado')
    .setDescription('Muestra el estado actual de tareas en este servidor'),
  new SlashCommandBuilder()
    .setName('asignar_canal')
    .setDescription('Asigna el canal de respuesta para cada tarea')
    .addStringOption((opt) =>
      opt
        .setName('tarea')
        .setDescription('Tarea a configurar')
        .setRequired(true)
        .addChoices(
          { name: 'Maritimo/Terrestre', value: 'maritimo_terrestre' },
          { name: 'RUNS', value: 'runs' },
          { name: 'Plantacion', value: 'plantacion' },
          { name: 'Vender (Bolsa y Porro)', value: 'vender' }
        )
    )
    .addChannelOption((opt) =>
      opt
        .setName('canal')
        .setDescription('Canal de respuesta para la tarea')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('estadisticas')
    .setDescription('Estadisticas generales de cada mision en un rango de tiempo')
    .addStringOption((opt) =>
      opt
        .setName('rango')
        .setDescription('Periodo rapido (se ignora si usas desde/hasta)')
        .addChoices(
          { name: 'Ultimas 24 horas', value: '24h' },
          { name: 'Ultimos 7 dias', value: '7d' },
          { name: 'Ultimos 30 dias', value: '30d' },
          { name: 'Historico completo', value: 'all' }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('desde')
        .setDescription('Fecha inicio: YYYY-MM-DD o YYYY-MM-DD HH:MM (tambien DD/MM/YYYY)')
    )
    .addStringOption((opt) =>
      opt
        .setName('hasta')
        .setDescription('Fecha fin: YYYY-MM-DD o YYYY-MM-DD HH:MM (tambien DD/MM/YYYY)')
    ),
  new SlashCommandBuilder()
    .setName('config_cd')
    .setDescription('Configura el cooldown de una tarea (solo administradores)')
    .addStringOption((opt) =>
      opt
        .setName('tarea')
        .setDescription('Tarea a configurar')
        .setRequired(true)
        .addChoices(
          { name: 'Maritimo', value: 'maritimo' },
          { name: 'Terrestre', value: 'terrestre' },
          { name: 'RUNS', value: 'runs' },
          { name: 'Plantacion (ciclo)', value: 'plantacion' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('horas')
        .setDescription('Duracion del cooldown en horas (minimo 1)')
        .setRequired(true)
        .setMinValue(1)
    )
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const TASK_SETTINGS = {
  maritimo_terrestre: {
    channelField: 'maritimeTerrestrialChannelId',
    panelField: 'maritimeTerrestrialPanelMessageId',
    label: 'Marítimo/Terrestre'
  },
  runs: {
    channelField: 'runsChannelId',
    panelField: 'runsPanelMessageId',
    label: 'RUNS'
  },
  plantacion: {
    channelField: 'plantationChannelId',
    panelField: 'plantationPanelMessageId',
    label: 'Plantación'
  },
  vender: {
    channelField: 'venderChannelId',
    panelField: 'venderPanelMessageId',
    label: 'Vender (Bolsa y Porro)'
  }
};

const TASK_ALIASES = {
  maritimo_terrestre: 'maritimo_terrestre',
  'maritimo-terrestre': 'maritimo_terrestre',
  maritime_terrestrial: 'maritimo_terrestre',
  runs: 'runs',
  plantacion: 'plantacion',
  plantation: 'plantacion',
  vender: 'vender'
};

async function registerCommands() {
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[OK] Slash commands registrados por servidor (GUILD_ID: ${GUILD_ID}) — disponibles de inmediato.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('[OK] Slash commands registrados globalmente — pueden tardar hasta 1 hora en propagarse.');
  }
}

function getGuildState(state, guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      mainChannelId: null,
      maritimeTerrestrialChannelId: null,
      runsChannelId: null,
      plantationChannelId: null,
      venderChannelId: null,
      maritimeTerrestrialPanelMessageId: null,
      runsPanelMessageId: null,
      plantationPanelMessageId: null,
      venderPanelMessageId: null,
      responseChannels: {},
      missionPanels: {},
      adminPanelRef: null,
      customCooldowns: {},
      vender: { active: false, nextNotificationAt: null, pendingDelete: null },
      runs: {
        status: 'available',
        cooldownEndsAt: null,
        notifiedReady: false,
        startedAt: null,
        uniqueUsers: []
      }
    };
  }

  if (state.guilds[guildId].runsChannelId === undefined) {
    state.guilds[guildId].runsChannelId = null;
  }
  if (state.guilds[guildId].plantationChannelId === undefined) {
    state.guilds[guildId].plantationChannelId = null;
  }
  if (state.guilds[guildId].plantationPanelMessageId === undefined) {
    state.guilds[guildId].plantationPanelMessageId = null;
  }
  if (state.guilds[guildId].venderChannelId === undefined) {
    state.guilds[guildId].venderChannelId = null;
  }
  if (state.guilds[guildId].venderPanelMessageId === undefined) {
    state.guilds[guildId].venderPanelMessageId = null;
  }

  const runs = state.guilds[guildId].runs;
  if (runs.startedAt === undefined) runs.startedAt = null;
  if (!Array.isArray(runs.uniqueUsers)) runs.uniqueUsers = [];

  if (!state.guilds[guildId].customCooldowns || typeof state.guilds[guildId].customCooldowns !== 'object') {
    state.guilds[guildId].customCooldowns = {};
  }
  if (!state.guilds[guildId].vender || typeof state.guilds[guildId].vender !== 'object') {
    state.guilds[guildId].vender = { active: false, nextNotificationAt: null, pendingDelete: null };
  }
  if (state.guilds[guildId].vender.pendingDelete === undefined) {
    state.guilds[guildId].vender.pendingDelete = null;
  }
  if (state.guilds[guildId].adminPanelRef === undefined) {
    state.guilds[guildId].adminPanelRef = null;
  }

  ensureGuildPanelState(state.guilds[guildId]);

  return state.guilds[guildId];
}

function normalizeTaskKey(taskKey) {
  return TASK_ALIASES[taskKey] || taskKey;
}

function getTaskSettings(taskKey) {
  return TASK_SETTINGS[normalizeTaskKey(taskKey)] || null;
}

function ensureGuildPanelState(guildConfig) {
  if (!guildConfig.responseChannels || typeof guildConfig.responseChannels !== 'object') {
    guildConfig.responseChannels = {};
  }
  if (!guildConfig.missionPanels || typeof guildConfig.missionPanels !== 'object') {
    guildConfig.missionPanels = {};
  }

  for (const taskKey of Object.keys(TASK_SETTINGS)) {
    const settings = TASK_SETTINGS[taskKey];
    const channelId = guildConfig.responseChannels[taskKey] || guildConfig[settings.channelField] || null;
    guildConfig.responseChannels[taskKey] = channelId;
    guildConfig[settings.channelField] = channelId;

    const legacyMessageId = guildConfig[settings.panelField] || null;
    const panelRef = guildConfig.missionPanels[taskKey];
    if (panelRef && typeof panelRef === 'object' && panelRef.messageId) {
      guildConfig.missionPanels[taskKey] = {
        channelId: panelRef.channelId || channelId,
        messageId: panelRef.messageId
      };
      guildConfig[settings.panelField] = panelRef.messageId;
      continue;
    }

    guildConfig.missionPanels[taskKey] = legacyMessageId
      ? { channelId, messageId: legacyMessageId }
      : null;
    guildConfig[settings.panelField] = legacyMessageId;
  }
}

function addReport(state, report) {
  state.reports.push(report);
  if (state.reports.length > 3000) {
    state.reports = state.reports.slice(-3000);
  }
}

function ensureRuntimeState(state) {
  if (!state.guilds) state.guilds = {};
  if (!state.tasks) state.tasks = {};
  if (!state.reports) state.reports = [];
  if (!state.pendingEvidence) state.pendingEvidence = {};
  if (!state.pendingPlantation) state.pendingPlantation = {};
  return state;
}

const DEFAULT_COOLDOWNS = { maritimo: 24, terrestre: 8, runs: 4, plantacion: 3 };

const VENDER_NOTIFICATION_INTERVAL_MS = 40 * 60 * 1000; // 40 minutos
const VENDER_DELETE_DELAY_MS = 10 * 60 * 1000; // 10 minutos
const RUNS_AUTO_CLOSE_MS = 60 * 60 * 1000; // 1 hora

function getCustomCooldown(guildConfig, type) {
  return guildConfig.customCooldowns?.[type] ?? DEFAULT_COOLDOWNS[type] ?? 0;
}

function isAdmin(interaction) {
  return Boolean(
    interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
    interaction.guild?.ownerId === interaction.user.id
  );
}

function buildMainTaskButtons(guildConfig) {
  const maritimoHours = getCustomCooldown(guildConfig, 'maritimo');
  const terrestreHours = getCustomCooldown(guildConfig, 'terrestre');
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mt:maritimo:${maritimoHours}`)
        .setLabel(`Maritimo (${maritimoHours}h)`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mt:terrestre:${terrestreHours}`)
        .setLabel(`Terrestre (${terrestreHours}h)`)
        .setStyle(ButtonStyle.Success)
    )
  ];
}

function buildRunsButtons(runsStatus) {
  const inProgress = runsStatus === 'in_progress';
  const inCooldown = runsStatus === 'cooldown';

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('runs:start')
        .setLabel('Iniciar')
        .setStyle(ButtonStyle.Success)
        .setDisabled(inProgress || inCooldown),
      new ButtonBuilder()
        .setCustomId('runs:finish')
        .setLabel('Terminar')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!inProgress)
    )
  ];
}

function buildAdminPanelButtons(guildConfig) {
  const venderActive = guildConfig.vender?.active || false;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('main:estado')
        .setLabel('Ver estado')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('main:canales')
        .setLabel('Ver canales')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('main:list-evidence')
        .setLabel('Evidencias pendientes')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('main:stats')
        .setLabel('📊 Estadisticas')
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('main:regen-panel:maritimo_terrestre')
        .setLabel('Recrear panel MT')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('main:regen-panel:runs')
        .setLabel('Recrear panel RUNS')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('main:regen-panel:plantacion')
        .setLabel('Recrear panel Plantacion')
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('main:clean:maritimo_terrestre')
        .setLabel('Limpiar canal MT')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('main:clean:runs')
        .setLabel('Limpiar canal RUNS')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('main:clean:plantacion')
        .setLabel('Limpiar canal Plantacion')
        .setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('main:vender-toggle')
        .setLabel(venderActive ? '⛔ Detener Vender' : '▶️ Iniciar Vender')
        .setStyle(venderActive ? ButtonStyle.Danger : ButtonStyle.Success)
    )
  ];
}

function buildAdminPanelPayload(guildConfig) {
  const venderActive = guildConfig.vender?.active || false;
  const cds = guildConfig.customCooldowns || {};
  const cdEntries = Object.entries(cds);
  const cdText = cdEntries.length
    ? cdEntries.map(([t, h]) => `${t}: ${h}h`).join(', ')
    : 'Ninguno (usando defaults)';
  const content =
    '## Panel de Administración\n' +
    'Usa los botones para gestionar tareas y canales.\n' +
    `Vender (Bolsa y Porro): **${venderActive ? 'Activo 🟢' : 'Inactivo 🔴'}**\n` +
    `CDs personalizados: ${cdText}\n` +
    '_Usa `/config_cd` para cambiar cooldowns._';
  return { content, components: buildAdminPanelButtons(guildConfig) };
}

function getTaskChannelId(guildConfig, taskKey) {
  ensureGuildPanelState(guildConfig);
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const settings = getTaskSettings(normalizedTaskKey);
  if (settings) {
    return guildConfig.responseChannels[normalizedTaskKey] || guildConfig[settings.channelField] || null;
  }
  return null;
}

function setTaskChannelId(guildConfig, taskKey, channelId) {
  ensureGuildPanelState(guildConfig);
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const settings = getTaskSettings(normalizedTaskKey);
  if (!settings) return;
  guildConfig.responseChannels[normalizedTaskKey] = channelId || null;
  guildConfig[settings.channelField] = channelId || null;
}

function getMissionPanelRef(guildConfig, taskKey) {
  ensureGuildPanelState(guildConfig);
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const settings = getTaskSettings(normalizedTaskKey);
  if (!settings) return null;

  const panelRef = guildConfig.missionPanels[normalizedTaskKey];
  if (panelRef && panelRef.messageId) {
    return {
      channelId: panelRef.channelId || getTaskChannelId(guildConfig, normalizedTaskKey),
      messageId: panelRef.messageId
    };
  }

  const legacyMessageId = guildConfig[settings.panelField];
  if (!legacyMessageId) return null;
  return {
    channelId: getTaskChannelId(guildConfig, normalizedTaskKey),
    messageId: legacyMessageId
  };
}

function setMissionPanelRef(guildConfig, taskKey, panelRef) {
  ensureGuildPanelState(guildConfig);
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const settings = getTaskSettings(normalizedTaskKey);
  if (!settings) return;

  if (!panelRef || !panelRef.messageId) {
    guildConfig.missionPanels[normalizedTaskKey] = null;
    guildConfig[settings.panelField] = null;
    return;
  }

  const normalizedRef = {
    channelId: panelRef.channelId || getTaskChannelId(guildConfig, normalizedTaskKey),
    messageId: panelRef.messageId
  };
  guildConfig.missionPanels[normalizedTaskKey] = normalizedRef;
  guildConfig[settings.panelField] = normalizedRef.messageId;
}

function formatAssignedChannel(channelId) {
  return channelId ? `<#${channelId}>` : 'Sin asignar';
}

function buildChannelAssignmentText(guildConfig) {
  const mtChannelId = getTaskChannelId(guildConfig, 'maritimo_terrestre');
  const runsChannelId = getTaskChannelId(guildConfig, 'runs');
  const plantationChannelId = getTaskChannelId(guildConfig, 'plantacion');
  const venderChannelId = getTaskChannelId(guildConfig, 'vender');

  return [
    '### Canales de respuesta',
    `- Maritimo/Terrestre -> ${formatAssignedChannel(mtChannelId)}`,
    `- RUNS -> ${formatAssignedChannel(runsChannelId)}`,
    `- Plantacion -> ${formatAssignedChannel(plantationChannelId)}`,
    `- Vender -> ${formatAssignedChannel(venderChannelId)}`
  ].join('\n');
}

async function buildRunsPanelText(guildConfig) {
  const runs = guildConfig.runs;
  const userCount = (runs.uniqueUsers || []).length;
  const runsHours = getCustomCooldown(guildConfig, 'runs');

  if (runs.status === 'available') {
    return (
      '## RUNS\n' +
      'Estado: **DISPONIBLE**\n' +
      `Usuarios que han hecho RUNS: **${userCount}**\n` +
      'Presiona **Iniciar** cuando comiencen.'
    );
  }
  if (runs.status === 'in_progress') {
    return (
      '## RUNS\n' +
      'Estado: **EN PROGRESO**\n' +
      `Usuarios que han hecho RUNS: **${userCount}**\n` +
      'Cuando finalice, presiona **Terminar**.'
    );
  }

  const left = Math.max(0, (runs.cooldownEndsAt || 0) - Date.now());
  return (
    '## RUNS\n' +
    `Estado: **EN CD (${runsHours}h)**\n` +
    `Tiempo restante: **${formatDuration(left)}**\n` +
    `Usuarios que han hecho RUNS: **${userCount}**`
  );
}

function buildPlantationPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('plant:start:ramas')
        .setLabel('Ramas')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('plant:start:duplicado')
        .setLabel('Duplicado')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

function buildPlantationTaskButtons(task) {
  if (task.status === 'awaiting_fourth') {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`plant:add4:${task.id}`)
          .setLabel('Agregar ciclo extra')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`plant:finish:${task.id}`)
          .setLabel('Finalizar sin extra')
          .setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  if (task.status === 'in_progress') {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`plant:cycle:${task.id}`)
          .setLabel(`Marcar ciclo ${task.completedCycles + 1}/${task.totalCycles}`)
          .setStyle(ButtonStyle.Primary)
      )
    ];
  }

  return [];
}

function buildPlantationTaskText(task) {
  const typeLabel = task.type === 'ramas' ? 'Ramas' : 'Duplicado';
  const lines = [];

  lines.push(`## Plantacion - ${typeLabel}`);
  lines.push(`Responsable: <@${task.userId}>`);
  lines.push(`Semillas: **${task.seedCount}**`);
  lines.push(`Progreso: **${task.completedCycles}/${task.totalCycles}** ciclos`);

  if (task.status === 'awaiting_fourth') {
    lines.push('Se cumplieron 2 ciclos. Elige si deseas agregar un ciclo extra.');
  } else if (task.status === 'completed') {
    lines.push('Estado: **COMPLETADO**');
  } else {
    const left = Math.max(0, (task.nextCycleEndsAt || 0) - Date.now());
    lines.push(`Tiempo restante del ciclo actual: **${formatDuration(left)}**`);
  }

  return lines.join('\n');
}

async function buildPlantationPanelText(guildConfig) {
  return (
    '## Plantacion\n' +
    'Selecciona el tipo de mision:\n' +
    '- **Ramas**: 2 ciclos de 3h, con opción de ciclo extra al final.\n' +
    '- **Duplicado**: 1 ciclo único de 3h.'
  );
}

function createPlantationInputKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function notifyPlantationChannel(guild, guildConfig, text) {
  const channelId = getTaskChannelId(guildConfig, 'plantacion');
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  await channel.send(text).catch(() => null);
}

async function notifyUserPlantation(guild, userId, text) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  const sent = await user.send(`🌱 [${guild.name}] ${text}`).catch(() => null);
  return Boolean(sent);
}

function createEvidenceKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function buildMaritimeTerrestrialPanelPayload(guildConfig) {
  return {
    content:
      '## Marítimo / Terrestre\n' +
      `Marítimo tiene CD actual de ${getCustomCooldown(guildConfig, 'maritimo')}h y Terrestre CD actual de ${getCustomCooldown(guildConfig, 'terrestre')}h.\n` +
      'Selecciona uno y luego sube la evidencia (foto). La mision se valida automáticamente.',
    components: buildMainTaskButtons(guildConfig)
  };
}

async function buildRunsPanelPayload(guildConfig) {
  return {
    content: await buildRunsPanelText(guildConfig),
    components: buildRunsButtons(guildConfig.runs.status)
  };
}

async function buildPlantationPanelPayload(guildConfig) {
  return {
    content: await buildPlantationPanelText(guildConfig),
    components: buildPlantationPanelButtons()
  };
}

async function buildMissionPanelPayload(taskKey, guildConfig) {
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  if (normalizedTaskKey === 'maritimo_terrestre') {
    return buildMaritimeTerrestrialPanelPayload(guildConfig);
  }
  if (normalizedTaskKey === 'runs') {
    return buildRunsPanelPayload(guildConfig);
  }
  if (normalizedTaskKey === 'plantacion') {
    return buildPlantationPanelPayload(guildConfig);
  }
  throw new Error(`Tipo de panel no soportado: ${normalizedTaskKey}`);
}

async function fetchMissionPanelChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased() || typeof channel.send !== 'function') {
    return null;
  }
  return channel;
}

async function deleteMissionPanelMessage(guild, panelRef) {
  if (!panelRef?.channelId || !panelRef?.messageId) return false;

  const channel = await fetchMissionPanelChannel(guild, panelRef.channelId);
  if (!channel) return false;

  const message = await channel.messages.fetch(panelRef.messageId).catch(() => null);
  if (!message) return false;

  const deletedMessage = await message.delete().catch(() => null);
  return Boolean(deletedMessage);
}

async function publishMissionPanel(guild, guildConfig, taskKey, options = {}) {
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const targetChannelId = getTaskChannelId(guildConfig, normalizedTaskKey);
  const targetChannel = await fetchMissionPanelChannel(guild, targetChannelId);
  if (!targetChannel) {
    throw new Error(`Canal no compatible o sin permisos de envio: ${targetChannelId || 'sin_asignar'}`);
  }

  const payload = await buildMissionPanelPayload(normalizedTaskKey, guildConfig);
  const previousRef = options.ignoreExisting ? null : getMissionPanelRef(guildConfig, normalizedTaskKey);
  let panelMessage = null;
  let action = 'create';
  let previousHandled = false;

  if (previousRef?.messageId && previousRef.channelId === targetChannel.id) {
    const previousMessage = await targetChannel.messages.fetch(previousRef.messageId).catch(() => null);
    if (previousMessage) {
      let shouldEdit = true;

      if (options.ensureLast) {
        const newerMessages = await targetChannel.messages
          .fetch({ after: previousMessage.id, limit: 1 })
          .catch(() => null);
        if (newerMessages && newerMessages.size > 0) {
          // There are newer messages — delete existing panel and re-post at the end
          await previousMessage.delete().catch(() => null);
          previousHandled = true;
          shouldEdit = false;
          action = 'repost';
          if (options.logPrefix) {
            console.log(
              `${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} action=repost (newer messages found)`
            );
          }
        }
      }

      if (shouldEdit) {
        try {
          panelMessage = await previousMessage.edit(payload);
          action = 'edit';
          previousHandled = true;
        } catch (error) {
          if (options.logPrefix) {
            console.warn(
              `${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} action=edit_failed`,
              error
            );
          }
        }
      }
    }
  }

  if (!panelMessage) {
    panelMessage = await targetChannel.send(payload);
  }

  setMissionPanelRef(guildConfig, normalizedTaskKey, {
    channelId: targetChannel.id,
    messageId: panelMessage.id
  });

  let cleanedPrevious = false;
  if (
    !previousHandled &&
    previousRef?.messageId &&
    (previousRef.channelId !== panelMessage.channelId || previousRef.messageId !== panelMessage.id)
  ) {
    cleanedPrevious = await deleteMissionPanelMessage(guild, previousRef);
    if (options.logPrefix && previousRef.channelId !== targetChannel.id) {
      console.log(
        `${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} previous_channel=${previousRef.channelId} cleanup=${cleanedPrevious ? 'deleted' : 'skipped'}`
      );
    }
  }

  if (options.logPrefix && action !== 'repost') {
    console.log(`${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} action=${action}`);
  }

  return {
    action,
    channelId: targetChannel.id,
    messageId: panelMessage.id,
    cleanedPrevious
  };
}

async function publishAdminPanel(guild, guildConfig) {
  const channelId = guildConfig.mainChannelId;
  if (!channelId) return null;

  const channel = await fetchMissionPanelChannel(guild, channelId);
  if (!channel) return null;

  const payload = buildAdminPanelPayload(guildConfig);
  let panelMessage = null;
  const previousRef = guildConfig.adminPanelRef;

  if (previousRef?.messageId && previousRef.channelId === channel.id) {
    const previousMessage = await channel.messages.fetch(previousRef.messageId).catch(() => null);
    if (previousMessage) {
      panelMessage = await previousMessage.edit(payload).catch(() => null);
    }
  }

  if (!panelMessage) {
    panelMessage = await channel.send(payload).catch(() => null);
  }

  if (panelMessage) {
    guildConfig.adminPanelRef = { channelId: channel.id, messageId: panelMessage.id };
  }

  return panelMessage;
}

async function cleanMissionChannel(guild, guildConfig, taskKey) {
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const channelId = getTaskChannelId(guildConfig, normalizedTaskKey);
  if (!channelId) return { deleted: 0, error: 'Canal no asignado' };

  const channel = await fetchMissionPanelChannel(guild, channelId);
  if (!channel) return { deleted: 0, error: 'Canal no accesible' };

  const panelRef = getMissionPanelRef(guildConfig, normalizedTaskKey);
  const panelMessageId = panelRef?.messageId || null;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return { deleted: 0, error: 'No se pudo obtener mensajes' };

  const toDelete = messages.filter((m) => m.id !== panelMessageId);
  if (toDelete.size === 0) return { deleted: 0 };

  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = toDelete.filter((m) => m.createdTimestamp > twoWeeksAgo);
  const old = toDelete.filter((m) => m.createdTimestamp <= twoWeeksAgo);

  let deleted = 0;

  if (recent.size > 1) {
    await channel.bulkDelete(recent).catch((e) => {
      console.error(`[clean] bulkDelete fallido canal=${channelId}: ${e.message}`);
    });
    deleted += recent.size;
  } else if (recent.size === 1) {
    await recent.first().delete().catch(() => null);
    deleted += 1;
  }

  for (const [, msg] of old) {
    await msg.delete().catch(() => null);
    deleted++;
  }

  console.log(`[clean] canal=${channelId} tarea=${normalizedTaskKey} eliminados=${deleted}`);
  return { deleted };
}

async function setupPanels(interaction, state, guildConfig) {
  const channel = interaction.channel;

  guildConfig.mainChannelId = channel.id;

  await publishAdminPanel(interaction.guild, guildConfig);

  writeState(state);
}

async function refreshRunsPanel(guild, guildConfig) {
  if (!getTaskChannelId(guildConfig, 'runs')) return;
  await publishMissionPanel(guild, guildConfig, 'runs', { ensureLast: true });
}

async function refreshMTPanel(guild, guildConfig) {
  if (!getTaskChannelId(guildConfig, 'maritimo_terrestre')) return;
  await publishMissionPanel(guild, guildConfig, 'maritimo_terrestre', { ensureLast: true });
}

function ensureTaskContainer(state, guildId) {
  if (!state.tasks[guildId]) {
    state.tasks[guildId] = {
      maritimeTerrestrial: [],
      plantation: []
    };
  }
  if (!state.tasks[guildId].plantation) {
    state.tasks[guildId].plantation = [];
  }
  return state.tasks[guildId];
}

async function refreshPlantationPanel(guild, guildConfig) {
  if (!getTaskChannelId(guildConfig, 'plantacion')) return;
  await publishMissionPanel(guild, guildConfig, 'plantacion', { ensureLast: true });
}

async function ensurePlantationPanel(guild, guildConfig) {
  if (!getTaskChannelId(guildConfig, 'plantacion')) return;
  await publishMissionPanel(guild, guildConfig, 'plantacion');
}

async function notifyMain(guild, guildConfig, text) {
  if (!guildConfig.mainChannelId) return;
  const channel = await guild.channels.fetch(guildConfig.mainChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  await channel.send(text).catch(() => null);
}

async function notifyMaritimeTerrestrialChannel(guild, guildConfig, text) {
  const channelId = getTaskChannelId(guildConfig, 'maritimo_terrestre');
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  await channel.send(text).catch(() => null);
}

async function notifyRunsChannel(guild, guildConfig, text) {
  const channelId = getTaskChannelId(guildConfig, 'runs');
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  await channel.send(text).catch(() => null);
}

async function notifyUserCooldownFinished(guild, task) {
  const typeLabel = task.type === 'maritimo' ? 'Maritimo' : 'Terrestre';
  const message = `✅ Tu cooldown de **${typeLabel} (${task.cooldownHours}h)** en **${guild.name}** ya termino.`;

  const user = await client.users.fetch(task.userId).catch(() => null);
  if (!user) return false;
  const sent = await user.send(message).catch(() => null);
  return Boolean(sent);
}

async function handleMaritimeTerrestrialButton(interaction, state, guildConfig) {
  const [, taskType, hoursRaw] = interaction.customId.split(':');
  const hours = Number(hoursRaw);
  const key = createEvidenceKey(interaction.guildId, interaction.user.id);
  const tasks = ensureTaskContainer(state, interaction.guildId);

  const existing = tasks.maritimeTerrestrial.find(
    (t) => t.userId === interaction.user.id && t.type === taskType && t.endsAt > Date.now()
  );
  if (existing) {
    await interaction.reply({
      content:
        `Ya tienes **${taskType}** en cooldown. ` +
        `Termina <t:${Math.floor(existing.endsAt / 1000)}:R>.`,
      ephemeral: true
    });
    return;
  }

  state.pendingEvidence[key] = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    taskType,
    cooldownHours: hours,
    createdAt: Date.now()
  };

  writeState(state);

  await interaction.reply({
    content:
      `Se preparo registro para **${taskType}** (${hours}h). ` +
      'Ahora sube una foto de evidencia en este canal.\n' +
      'Al detectar la imagen, la mision se valida automaticamente y entra en CD.',
    ephemeral: true
  });

  await notifyMaritimeTerrestrialChannel(
    interaction.guild,
    guildConfig,
    `📌 ${interaction.user} preparo registro de **${taskType} (${hours}h)** y espera evidencia.`
  );
}

async function handleRunsButton(interaction, state, guildConfig) {
  const action = interaction.customId.split(':')[1];
  const runs = guildConfig.runs;

  if (action === 'start') {
    if (runs.status !== 'available') {
      await interaction.reply({
        content: 'RUNS no esta disponible para iniciar.',
        ephemeral: true
      });
      return;
    }

    runs.status = 'in_progress';
    runs.notifiedReady = false;
    runs.startedAt = Date.now();

    // Track unique user
    if (!Array.isArray(runs.uniqueUsers)) runs.uniqueUsers = [];
    if (!runs.uniqueUsers.includes(interaction.user.id)) {
      runs.uniqueUsers.push(interaction.user.id);
    }

    addReport(state, {
      kind: 'runs_start',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      createdAt: Date.now()
    });

    writeState(state);

    await interaction.reply({
      content: 'RUNS iniciada correctamente.',
      ephemeral: true
    });

    await notifyRunsChannel(interaction.guild, guildConfig, `🚀 ${interaction.user} inició una RUNS.`);
    await refreshRunsPanel(interaction.guild, guildConfig);
    writeState(state);
    return;
  }

  if (action === 'finish') {
    if (runs.status !== 'in_progress') {
      await interaction.reply({
        content: 'No hay una RUNS en progreso para finalizar.',
        ephemeral: true
      });
      return;
    }

    const runsHours = getCustomCooldown(guildConfig, 'runs');
    runs.status = 'cooldown';
    runs.cooldownEndsAt = addHours(runsHours);
    runs.notifiedReady = false;
    runs.startedAt = null;

    addReport(state, {
      kind: 'runs_finish',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      createdAt: Date.now()
    });

    writeState(state);

    await interaction.reply({
      content: `RUNS finalizada. CD de ${runsHours}h iniciado.`,
      ephemeral: true
    });

    await notifyRunsChannel(
      interaction.guild,
      guildConfig,
      `⏳ ${interaction.user} finalizó RUNS. Queda en cooldown por ${runsHours} horas.`
    );
    await refreshRunsPanel(interaction.guild, guildConfig);
    writeState(state);
  }
}

function findPlantationTask(tasks, taskId) {
  return tasks.plantation.find((t) => t.id === taskId) || null;
}

async function updatePlantationTaskMessage(guild, task) {
  const channel = await guild.channels.fetch(task.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(task.messageId).catch(() => null);
  if (!message) return;

  await message.edit({
    content: buildPlantationTaskText(task),
    components: buildPlantationTaskButtons(task)
  });
}

async function handlePlantationStartButton(interaction, state, guildConfig) {
  const type = interaction.customId.split(':')[2];
  const tasks = ensureTaskContainer(state, interaction.guildId);
  const hasOpenTask = tasks.plantation.some(
    (t) => t.userId === interaction.user.id && (t.status === 'in_progress' || t.status === 'awaiting_fourth')
  );

  if (hasOpenTask) {
    await interaction.reply({
      content: 'Ya tienes una plantacion activa. Termina esa antes de iniciar otra.',
      ephemeral: true
    });
    return;
  }

  const key = createPlantationInputKey(interaction.guildId, interaction.user.id);
  state.pendingPlantation[key] = {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    type,
    createdAt: Date.now()
  };
  writeState(state);

  await interaction.reply({
    content: `Elegiste **${type}**. Escribe ahora la cantidad de semillas en este canal (solo numero).`,
    ephemeral: true
  });
}

async function handlePlantationActionButton(interaction, state, guildConfig) {
  const [, action, taskId] = interaction.customId.split(':');
  const tasks = ensureTaskContainer(state, interaction.guildId);
  const task = findPlantationTask(tasks, taskId);

  if (!task) {
    await interaction.reply({ content: 'No se encontro esa tarea de plantacion.', ephemeral: true });
    return;
  }

  if (task.userId !== interaction.user.id) {
    await interaction.reply({
      content: `Solo <@${task.userId}> puede marcar esta plantacion.`,
      ephemeral: true
    });
    return;
  }

  if (action === 'cycle') {
    if (task.status !== 'in_progress') {
      await interaction.reply({ content: 'Esta tarea no esta en progreso.', ephemeral: true });
      return;
    }

    const now = Date.now();
    if (task.nextCycleEndsAt && now < task.nextCycleEndsAt) {
      await interaction.reply({
        content: `Aun no termina el ciclo actual. Faltan ${formatDuration(task.nextCycleEndsAt - now)}.`,
        ephemeral: true
      });
      return;
    }

    task.completedCycles += 1;
    task.cycleReadyNotified = false;

    addReport(state, {
      kind: 'plantation_cycle',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      type: task.type,
      cycleNumber: task.completedCycles,
      totalCycles: task.totalCycles,
      createdAt: Date.now()
    });

    if (task.completedCycles >= task.totalCycles) {
      if (task.type === 'ramas' && task.totalCycles === 2) {
        task.status = 'awaiting_fourth';
        task.nextCycleEndsAt = null;

        const dmSent = await notifyUserPlantation(
          interaction.guild,
          task.userId,
          'Completaste 2/2 ciclos de Ramas. Ya puedes decidir si agregas un ciclo extra.'
        );
        await notifyPlantationChannel(
          interaction.guild,
          guildConfig,
          `🌱 <@${task.userId}> completo 2/2 ciclos de **ramas** y puede decidir ciclo extra.` +
            `${dmSent ? ' Se envio DM.' : ' No se pudo enviar DM.'}`
        );
      } else {
        task.status = 'completed';
        task.nextCycleEndsAt = null;
        task.completedAt = Date.now();

        addReport(state, {
          kind: 'plantation_finish',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          type: task.type,
          seeds: task.seedCount,
          totalCycles: task.totalCycles,
          createdAt: Date.now()
        });

        const dmSent = await notifyUserPlantation(
          interaction.guild,
          task.userId,
          `Completaste plantacion ${task.type} (${task.completedCycles}/${task.totalCycles} ciclos).`
        );
        await notifyPlantationChannel(
          interaction.guild,
          guildConfig,
          `✅ <@${task.userId}> completo plantacion **${task.type}** (${task.completedCycles}/${task.totalCycles} ciclos).` +
            `${dmSent ? ' Se envio DM.' : ' No se pudo enviar DM.'}`
        );
      }
    } else {
      task.nextCycleEndsAt = addHours(getCustomCooldown(guildConfig, 'plantacion'));
    }

    writeState(state);
    await updatePlantationTaskMessage(interaction.guild, task);
    await interaction.reply({ content: 'Ciclo marcado correctamente.', ephemeral: true });
    return;
  }

  if (action === 'add4') {
    if (task.status !== 'awaiting_fourth' || task.type !== 'ramas') {
      await interaction.reply({ content: 'Esta opcion no aplica a esta tarea.', ephemeral: true });
      return;
    }
    task.totalCycles = 3;
    task.status = 'in_progress';
    task.nextCycleEndsAt = addHours(getCustomCooldown(guildConfig, 'plantacion'));
    task.cycleReadyNotified = false;

    const dmSent = await notifyUserPlantation(
      interaction.guild,
      task.userId,
      'Se agrego el ciclo extra de Ramas. Te avisaremos cuando puedas marcarlo.'
    );
    await notifyPlantationChannel(
      interaction.guild,
      guildConfig,
      `🌱 <@${task.userId}> agrego el ciclo extra de **ramas**.` +
        `${dmSent ? ' Se envio DM.' : ' No se pudo enviar DM.'}`
    );

    writeState(state);
    await updatePlantationTaskMessage(interaction.guild, task);
    await interaction.reply({ content: 'Se agrego el ciclo extra.', ephemeral: true });
    return;
  }

  if (action === 'finish') {
    if (task.status !== 'awaiting_fourth') {
      await interaction.reply({ content: 'Esta tarea no espera decision de ciclo extra.', ephemeral: true });
      return;
    }

    task.status = 'completed';
    task.nextCycleEndsAt = null;
    task.completedAt = Date.now();

    addReport(state, {
      kind: 'plantation_finish',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      type: task.type,
      seeds: task.seedCount,
      totalCycles: task.totalCycles,
      createdAt: Date.now()
    });

    writeState(state);
    await updatePlantationTaskMessage(interaction.guild, task);
    const dmSent = await notifyUserPlantation(
      interaction.guild,
      task.userId,
      'Completaste plantacion ramas sin ciclo extra.'
    );
    await notifyPlantationChannel(
      interaction.guild,
      guildConfig,
      `✅ <@${task.userId}> completo plantacion **${task.type}** sin ciclo extra.` +
        `${dmSent ? ' Se envio DM.' : ' No se pudo enviar DM.'}`
    );
    await interaction.reply({ content: 'Plantacion finalizada.', ephemeral: true });
  }
}

function cleanExpiredPendingEvidence(state) {
  const fiveMinutes = 5 * 60 * 1000;
  const now = Date.now();
  for (const [key, pending] of Object.entries(state.pendingEvidence)) {
    if (now - pending.createdAt > fiveMinutes) {
      delete state.pendingEvidence[key];
    }
  }

  const tenMinutes = 10 * 60 * 1000;
  for (const [key, pending] of Object.entries(state.pendingPlantation || {})) {
    if (now - pending.createdAt > tenMinutes) {
      delete state.pendingPlantation[key];
    }
  }
}

const RANGE_PRESETS = {
  '24h': { label: 'Ultimas 24 horas', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: 'Ultimos 7 dias', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: 'Ultimos 30 dias', ms: 30 * 24 * 60 * 60 * 1000 },
  all: { label: 'Historico completo', ms: null }
};

function buildStatsRangeMenu() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('stats:range')
        .setPlaceholder('Elige el periodo a consultar')
        .addOptions(
          Object.entries(RANGE_PRESETS).map(([value, preset]) => ({
            label: preset.label,
            value
          }))
        )
    )
  ];
}

function parseDateInput(raw, endOfDay = false) {
  if (!raw) return null;
  const value = String(raw).trim();

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(value);
  if (!match) {
    const alt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(value);
    if (alt) match = [alt[0], alt[3], alt[2], alt[1], alt[4], alt[5]];
  }
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const hasTime = hour !== undefined;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    hasTime ? Number(hour) : endOfDay ? 23 : 0,
    hasTime ? Number(minute) : endOfDay ? 59 : 0,
    hasTime ? 0 : endOfDay ? 59 : 0,
    hasTime ? 0 : endOfDay ? 999 : 0
  );

  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function resolveStatsRange({ rangeKey, desde, hasta }) {
  const now = Date.now();
  const fromCustom = parseDateInput(desde, false);
  const toCustom = parseDateInput(hasta, true);

  if (desde && fromCustom === null) {
    return { error: `No pude leer la fecha "desde": \`${desde}\`. Usa YYYY-MM-DD o YYYY-MM-DD HH:MM.` };
  }
  if (hasta && toCustom === null) {
    return { error: `No pude leer la fecha "hasta": \`${hasta}\`. Usa YYYY-MM-DD o YYYY-MM-DD HH:MM.` };
  }

  if (fromCustom !== null || toCustom !== null) {
    const from = fromCustom !== null ? fromCustom : 0;
    const to = toCustom !== null ? toCustom : now;
    if (from > to) {
      return { error: 'El inicio del rango es posterior al final. Revisa las fechas.' };
    }
    return { from, to, label: 'Rango personalizado' };
  }

  const preset = RANGE_PRESETS[rangeKey] || RANGE_PRESETS['7d'];
  return {
    from: preset.ms === null ? 0 : now - preset.ms,
    to: now,
    label: preset.label
  };
}

function countByUser(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.userId, (counts.get(item.userId) || 0) + 1);
  }
  return counts;
}

function formatUserRanking(counts, limit = 10) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!entries.length) return ['- Sin registros en este periodo'];

  const lines = entries
    .slice(0, limit)
    .map(([userId, count], index) => `${index + 1}. <@${userId}> - ${count}`);

  if (entries.length > limit) {
    lines.push(`... y ${entries.length - limit} usuario(s) mas`);
  }
  return lines;
}

function formatRangeHeader(from, to) {
  const desde = from > 0 ? `<t:${Math.floor(from / 1000)}:f>` : 'el inicio';
  return `Desde ${desde} hasta <t:${Math.floor(to / 1000)}:f>`;
}

function truncateForDiscord(text, limit = 1950) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 40)}\n... (recortado por limite de Discord)`;
}

function buildStatsText(state, guildId, { from, to, label }) {
  const reports = state.reports.filter(
    (r) => r.guildId === guildId && r.createdAt >= from && r.createdAt <= to
  );

  const mtReports = reports.filter((r) => r.kind === 'maritime_terrestrial');
  const maritime = mtReports.filter((r) => r.type === 'maritimo');
  const terrestrial = mtReports.filter((r) => r.type === 'terrestre');
  const runsStarts = reports.filter((r) => r.kind === 'runs_start');
  const runsFinishes = reports.filter((r) => r.kind === 'runs_finish');
  const runsAutoClosed = reports.filter((r) => r.kind === 'runs_auto_close');
  const plantStarts = reports.filter((r) => r.kind === 'plantation_start');
  const plantFinishes = reports.filter((r) => r.kind === 'plantation_finish');
  const plantCycles = reports.filter((r) => r.kind === 'plantation_cycle');

  const lines = [];
  lines.push(`## Estadisticas generales - ${label}`);
  lines.push(formatRangeHeader(from, to));
  lines.push('');

  lines.push(`### Maritimo (${maritime.length} misiones)`);
  lines.push(`Usuarios distintos: ${new Set(maritime.map((r) => r.userId)).size}`);
  lines.push(...formatUserRanking(countByUser(maritime)));
  lines.push('');

  lines.push(`### Terrestre (${terrestrial.length} misiones)`);
  lines.push(`Usuarios distintos: ${new Set(terrestrial.map((r) => r.userId)).size}`);
  lines.push(...formatUserRanking(countByUser(terrestrial)));
  lines.push('');

  lines.push(`### RUNS (${runsStarts.length} iniciadas / ${runsFinishes.length} finalizadas)`);
  if (runsAutoClosed.length) {
    lines.push(`Cerradas automaticamente por inactividad: ${runsAutoClosed.length}`);
  }
  lines.push(`Usuarios distintos: ${new Set(runsStarts.map((r) => r.userId)).size}`);
  lines.push(...formatUserRanking(countByUser(runsStarts)));
  lines.push('');

  const seeds = plantStarts.reduce((acc, r) => acc + (Number(r.seeds) || 0), 0);
  lines.push(`### Plantacion (${plantStarts.length} iniciadas / ${plantFinishes.length} finalizadas)`);
  lines.push(`Ciclos marcados: ${plantCycles.length} | Semillas usadas: ${seeds}`);
  lines.push(`Usuarios distintos: ${new Set(plantStarts.map((r) => r.userId)).size}`);
  lines.push(...formatUserRanking(countByUser(plantStarts)));

  const totalActivity = mtReports.length + runsStarts.length + plantStarts.length;
  if (!totalActivity) {
    lines.push('');
    lines.push('No hay actividad registrada en este periodo.');
  }

  return truncateForDiscord(lines.join('\n'));
}

function buildEstadoText(state, guildId, guildConfig, guildTasks) {
  const lines = [];
  const now = Date.now();
  const guildReports = state.reports.filter((r) => r.guildId === guildId);
  const mtReports = guildReports.filter((r) => r.kind === 'maritime_terrestrial');
  const runsStartReports = guildReports.filter((r) => r.kind === 'runs_start');
  const runsFinishReports = guildReports.filter((r) => r.kind === 'runs_finish');
  const plantationStarts = guildReports.filter((r) => r.kind === 'plantation_start');
  const plantationFinishes = guildReports.filter((r) => r.kind === 'plantation_finish');

  const maritimeReports = mtReports.filter((r) => r.type === 'maritimo');
  const terrestrialReports = mtReports.filter((r) => r.type === 'terrestre');
  const runsUniqueUsers = new Set(runsStartReports.map((r) => r.userId)).size;
  const lastMaritime = maritimeReports.slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const lastTerrestrial =
    terrestrialReports.slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;

  lines.push('## Estado General');
  lines.push(buildChannelAssignmentText(guildConfig));
  lines.push('### RUNS');
  if (guildConfig.runs.status === 'available') {
    lines.push('- Disponible');
  } else if (guildConfig.runs.status === 'in_progress') {
    lines.push('- En progreso');
  } else {
    lines.push(`- En CD: ${formatDuration((guildConfig.runs.cooldownEndsAt || 0) - now)}`);
  }
  lines.push(`- RUNS iniciadas (total): ${runsStartReports.length}`);
  lines.push(`- RUNS finalizadas (total): ${runsFinishReports.length}`);
  lines.push(`- Usuarios que iniciaron RUNS: ${runsUniqueUsers}`);

  lines.push('### Maritimo/Terrestre activos');
  const active = (guildTasks?.maritimeTerrestrial || []).filter((t) => t.endsAt > now);
  if (!active.length) {
    lines.push('- Sin cooldowns activos');
  } else {
    for (const t of active) {
      lines.push(
        `- <@${t.userId}> | ${t.type} (${t.cooldownHours}h): ${formatDuration(t.endsAt - now)}`
      );
    }
  }

  lines.push('### Historial Maritimo/Terrestre');
  lines.push(`- Maritimo completado: ${maritimeReports.length}`);
  lines.push(`- Terrestre completado: ${terrestrialReports.length}`);
  lines.push(
    lastMaritime
      ? `- Ultimo Maritimo terminado por: <@${lastMaritime.userId}>`
      : '- Ultimo Maritimo terminado por: Sin registros'
  );
  lines.push(
    lastTerrestrial
      ? `- Ultimo Terrestre terminado por: <@${lastTerrestrial.userId}>`
      : '- Ultimo Terrestre terminado por: Sin registros'
  );

  if (mtReports.length) {
    const latest = mtReports
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
    lines.push('### Ultimos 5 registros MT');
    for (const item of latest) {
      lines.push(`- <@${item.userId}> hizo ${item.type} (${item.cooldownHours}h)`);
    }
  }

  lines.push('### Plantacion');
  lines.push(`- Iniciadas: ${plantationStarts.length}`);
  lines.push(`- Finalizadas: ${plantationFinishes.length}`);
  const activePlantation = (guildTasks?.plantation || []).filter(
    (t) => t.status === 'in_progress' || t.status === 'awaiting_fourth'
  );
  if (!activePlantation.length) {
    lines.push('- Activas: Ninguna');
  } else {
    for (const task of activePlantation.slice(-5)) {
      const phase =
        task.status === 'awaiting_fourth'
          ? 'esperando decision ciclo extra'
          : `ciclo ${task.completedCycles + 1}/${task.totalCycles}`;
      lines.push(`- <@${task.userId}> | ${task.type} | semillas ${task.seedCount} | ${phase}`);
    }
  }

  return lines.join('\n');
}

async function schedulerTick() {
  const state = ensureRuntimeState(readState());
  cleanExpiredPendingEvidence(state);

  let changed = false;
  const now = Date.now();

  for (const [guildId, guildConfig] of Object.entries(state.guilds)) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;

    const tasks = ensureTaskContainer(state, guildId);

    // Auto-close RUNS after 1 hour
    if (
      guildConfig.runs.status === 'in_progress' &&
      guildConfig.runs.startedAt &&
      now - guildConfig.runs.startedAt >= RUNS_AUTO_CLOSE_MS
    ) {
      const runsHours = getCustomCooldown(guildConfig, 'runs');
      console.log(
        `[auto-close] guildId=${guildId} Cerrando RUNS automaticamente por timeout de 1h`
      );
      guildConfig.runs.status = 'cooldown';
      guildConfig.runs.cooldownEndsAt = now + runsHours * 60 * 60 * 1000;
      guildConfig.runs.notifiedReady = false;
      guildConfig.runs.startedAt = null;

      addReport(state, {
        kind: 'runs_auto_close',
        guildId,
        createdAt: now
      });

      await notifyRunsChannel(
        guild,
        guildConfig,
        `⏰ RUNS cerrada automáticamente por superar 1 hora sin finalizar. CD de ${runsHours}h iniciado.`
      );
      changed = true;
    }

    // Handle RUNS cooldown end
    if (
      guildConfig.runs.status === 'cooldown' &&
      guildConfig.runs.cooldownEndsAt &&
      now >= guildConfig.runs.cooldownEndsAt
    ) {
      if (!guildConfig.runs.notifiedReady) {
        await notifyRunsChannel(guild, guildConfig, '🔔 @everyone RUNS esta disponible nuevamente.');
      }
      guildConfig.runs.status = 'available';
      guildConfig.runs.cooldownEndsAt = null;
      guildConfig.runs.notifiedReady = true;
      changed = true;
    }

    // Refresh all mission panels (ensureLast ensures panel is always the latest message)
    await refreshMTPanel(guild, guildConfig);
    await refreshRunsPanel(guild, guildConfig);
    await refreshPlantationPanel(guild, guildConfig);

    // Process MT cooldown expirations
    const activeMts = [];
    for (const task of tasks.maritimeTerrestrial) {
      if (task.endsAt <= now) {
        const dmSent = await notifyUserCooldownFinished(guild, task);
        await notifyMaritimeTerrestrialChannel(
          guild,
          guildConfig,
          `✅ ${task.type} (${task.cooldownHours}h) completado para <@${task.userId}>.` +
            `${dmSent ? ' Se envio DM de disponibilidad.' : ' No se pudo enviar DM; se notifica aqui por mencion.'}`
        );
        changed = true;
      } else {
        activeMts.push(task);
      }
    }
    tasks.maritimeTerrestrial = activeMts;

    // Process plantation cycle notifications
    for (const task of tasks.plantation) {
      if (task.status !== 'in_progress') continue;
      if (!task.nextCycleEndsAt) continue;
      if (now < task.nextCycleEndsAt) continue;
      if (task.cycleReadyNotified) continue;

      await notifyPlantationChannel(
        guild,
        guildConfig,
        `🌱 <@${task.userId}> ya puedes marcar el ciclo ${task.completedCycles + 1}/${task.totalCycles} de ${task.type}.`
      );
      await notifyUserPlantation(
        guild,
        task.userId,
        `Ya puedes marcar el ciclo ${task.completedCycles + 1}/${task.totalCycles} de ${task.type}.`
      );
      task.cycleReadyNotified = true;
      changed = true;
      await updatePlantationTaskMessage(guild, task);
    }

    // Vender (Bolsa y Porro) cyclic task
    if (!guildConfig.vender) {
      guildConfig.vender = { active: false, nextNotificationAt: null, pendingDelete: null };
    }
    const vender = guildConfig.vender;

    // Delete pending vender message if its time has come
    if (vender.pendingDelete && now >= vender.pendingDelete.deleteAt) {
      const venderCh = await guild.channels.fetch(vender.pendingDelete.channelId).catch(() => null);
      if (venderCh && typeof venderCh.send === 'function') {
        const venderMsg = await venderCh.messages.fetch(vender.pendingDelete.messageId).catch(() => null);
        if (venderMsg) {
          await venderMsg.delete().catch(() => null);
          console.log(`[vender] guildId=${guildId} Mensaje de vender eliminado tras ${VENDER_DELETE_DELAY_MS / 60000} min`);
        }
      }
      vender.pendingDelete = null;
      changed = true;
    }

    // Send new vender notification if active and due
    if (vender.active && (!vender.nextNotificationAt || now >= vender.nextNotificationAt)) {
      const venderChannelId = getTaskChannelId(guildConfig, 'vender');
      if (venderChannelId) {
        const venderCh = await guild.channels.fetch(venderChannelId).catch(() => null);
        if (venderCh && typeof venderCh.send === 'function') {
          const sentMsg = await venderCh
            .send('@everyone 🛒 ¡Es hora de **Vender (Bolsa y Porro)**!')
            .catch(() => null);
          if (sentMsg) {
            vender.pendingDelete = {
              channelId: venderCh.id,
              messageId: sentMsg.id,
              deleteAt: now + VENDER_DELETE_DELAY_MS
            };
            console.log(`[vender] guildId=${guildId} Notificacion enviada, se borrara en ${VENDER_DELETE_DELAY_MS / 60000} min`);
          }
        }
      } else {
        console.warn(`[vender] guildId=${guildId} Canal no asignado, saltando notificacion. Usa /asignar_canal tarea:vender`);
      }
      vender.nextNotificationAt = now + VENDER_NOTIFICATION_INTERVAL_MS;
      changed = true;
    }
  }

  // Always persist state (includes pending evidence cleanup)
  writeState(state);
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guildId) return;

  const state = ensureRuntimeState(readState());
  const guildConfig = getGuildState(state, message.guildId);

  const key = createEvidenceKey(message.guildId, message.author.id);
  const pending = state.pendingEvidence[key];
  const plantKey = createPlantationInputKey(message.guildId, message.author.id);
  const pendingPlantation = (state.pendingPlantation || {})[plantKey];

  if (pendingPlantation && pendingPlantation.channelId === message.channelId) {
    const value = Number.parseInt(message.content.trim(), 10);
    if (!Number.isFinite(value) || value <= 0) {
      await message.reply('Debes escribir una cantidad valida de semillas (numero mayor a 0).');
      return;
    }

    const tasks = ensureTaskContainer(state, message.guildId);
    const totalCycles = pendingPlantation.type === 'ramas' ? 2 : 1;
    const task = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      type: pendingPlantation.type,
      userId: message.author.id,
      channelId: message.channelId,
      messageId: null,
      seedCount: value,
      totalCycles,
      completedCycles: 0,
      status: 'in_progress',
      cycleReadyNotified: false,
      createdAt: Date.now(),
      nextCycleEndsAt: addHours(getCustomCooldown(guildConfig, 'plantacion'))
    };

    const taskMessage = await message.channel.send({
      content: buildPlantationTaskText(task),
      components: buildPlantationTaskButtons(task)
    });
    task.messageId = taskMessage.id;
    tasks.plantation.push(task);

    addReport(state, {
      kind: 'plantation_start',
      guildId: message.guildId,
      userId: message.author.id,
      type: pendingPlantation.type,
      seeds: value,
      totalCycles,
      createdAt: Date.now()
    });

    delete state.pendingPlantation[plantKey];
    writeState(state);

    const dmSent = await notifyUserPlantation(
      message.guild,
      message.author.id,
      `Iniciaste plantacion ${pendingPlantation.type} con ${value} semillas. Te avisaremos en cada ciclo.`
    );
    await notifyPlantationChannel(
      message.guild,
      guildConfig,
      `🌱 <@${message.author.id}> inicio plantacion **${pendingPlantation.type}** con **${value}** semillas.` +
        `${dmSent ? ' Se envio DM.' : ' No se pudo enviar DM.'}`
    );

    await message.reply(
      `🌱 Plantacion **${pendingPlantation.type}** iniciada con **${value}** semillas. ` +
        `Primer ciclo disponible para marcar en <t:${Math.floor(task.nextCycleEndsAt / 1000)}:R>.`
    );
    return;
  }

  if (pending && pending.channelId === message.channelId && message.attachments.size > 0) {
    const first = message.attachments.first();
    const isImage = first.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(first.name || '');

    if (!isImage) {
      await message.reply('La evidencia debe ser una imagen.');
      return;
    }

    const tasks = ensureTaskContainer(state, message.guildId);
    const endsAt = Date.now() + pending.cooldownHours * 60 * 60 * 1000;

    tasks.maritimeTerrestrial.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      type: pending.taskType,
      userId: message.author.id,
      channelId: pending.channelId,
      cooldownHours: pending.cooldownHours,
      startedAt: Date.now(),
      endsAt,
      evidenceUrl: first.url
    });

    addReport(state, {
      kind: 'maritime_terrestrial',
      guildId: message.guildId,
      userId: message.author.id,
      type: pending.taskType,
      cooldownHours: pending.cooldownHours,
      evidenceUrl: first.url,
      createdAt: Date.now(),
      endsAt
    });

    delete state.pendingEvidence[key];
    writeState(state);

    await message.reply(
      `✅ Mision **${pending.taskType} (${pending.cooldownHours}h)** validada automaticamente. ` +
        `Tu CD termina <t:${Math.floor(endsAt / 1000)}:R>.`
    );
    await notifyMaritimeTerrestrialChannel(
      message.guild,
      guildConfig,
      `✅ ${message.author} valido evidencia para ${pending.taskType} (${pending.cooldownHours}h).` +
        ` CD hasta <t:${Math.floor(endsAt / 1000)}:R>.`
    );
    return;
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guildId) return;

  const state = ensureRuntimeState(readState());
  const guildConfig = getGuildState(state, interaction.guildId);

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup') {
      await setupPanels(interaction, state, guildConfig);
      await interaction.reply({
        content:
          'Canal Main configurado. Panel de Administración creado.\n' +
          'Usa `/asignar_canal` para configurar el canal de cada misión.\n' +
          'Los paneles de misión se publicarán al asignar su canal.',
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'estado') {
      const tasks = ensureTaskContainer(state, interaction.guildId);
      await interaction.reply({
        content: buildEstadoText(state, interaction.guildId, guildConfig, tasks),
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'asignar_canal') {
      const taskKey = normalizeTaskKey(interaction.options.getString('tarea', true));
      const targetChannel = interaction.options.getChannel('canal', true);
      const taskSettings = getTaskSettings(taskKey);

      if (!taskSettings) {
        await interaction.reply({
          content: `Tipo de tarea no soportado: **${taskKey}**.`,
          ephemeral: true
        });
        return;
      }

      setTaskChannelId(guildConfig, taskKey, targetChannel.id);

      writeState(state);

      let panelStatusText = 'La asignación se guardó. Las notificaciones se enviarán a este canal.';
      if (taskKey !== 'vender') {
        panelStatusText = 'La asignación se guardó, pero no pude publicar el panel. Revisa permisos del bot en ese canal.';
        try {
          const publishResult = await publishMissionPanel(interaction.guild, guildConfig, taskKey, {
            logPrefix: '[asignar_canal]'
          });
          writeState(state);
          panelStatusText =
            `La asignación se guardó y el panel se ${publishResult.action === 'edit' ? 'actualizó' : 'publicó'} de inmediato.`;
        } catch (error) {
          console.error(
            `[asignar_canal] tipo=${taskKey} canal=${targetChannel.id} action=failed`,
            error
          );
        }
      }

      await interaction.reply({
        content:
          `Asignación actualizada para **${taskSettings.label}** en ${targetChannel}.\n` +
          `${panelStatusText}\n\n` +
          buildChannelAssignmentText(guildConfig),
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'estadisticas') {
      const range = resolveStatsRange({
        rangeKey: interaction.options.getString('rango') || '7d',
        desde: interaction.options.getString('desde'),
        hasta: interaction.options.getString('hasta')
      });

      if (range.error) {
        await interaction.reply({ content: range.error, ephemeral: true });
        return;
      }

      await interaction.reply({
        content: buildStatsText(state, interaction.guildId, range),
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === 'config_cd') {
      if (!isAdmin(interaction)) {
        await interaction.reply({
          content: '⛔ Solo administradores pueden usar este comando.',
          ephemeral: true
        });
        return;
      }

      const tipoCd = interaction.options.getString('tarea', true);
      const horas = interaction.options.getInteger('horas', true);

      if (!guildConfig.customCooldowns) guildConfig.customCooldowns = {};
      guildConfig.customCooldowns[tipoCd] = horas;
      writeState(state);

      // Refresh MT panel if CD affects button labels
      if (tipoCd === 'maritimo' || tipoCd === 'terrestre') {
        try {
          await publishMissionPanel(interaction.guild, guildConfig, 'maritimo_terrestre', {
            logPrefix: '[config_cd]'
          });
          writeState(state);
        } catch (e) {
          console.error('[config_cd] Error al refrescar panel MT:', e);
        }
      }

      // Refresh admin panel to show updated CDs
      await publishAdminPanel(interaction.guild, guildConfig);
      writeState(state);

      await interaction.reply({
        content: `✅ CD para **${tipoCd}** actualizado a **${horas}h**.`,
        ephemeral: true
      });
      return;
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'stats:range') {
    const range = resolveStatsRange({ rangeKey: interaction.values[0] });
    await interaction.update({
      content: buildStatsText(state, interaction.guildId, range),
      components: buildStatsRangeMenu()
    });
    return;
  }

  if (!interaction.isButton()) return;

  try {
    if (interaction.customId.startsWith('mt:')) {
      await handleMaritimeTerrestrialButton(interaction, state, guildConfig);
      return;
    }

    if (interaction.customId.startsWith('runs:')) {
      await handleRunsButton(interaction, state, guildConfig);
      return;
    }

    if (interaction.customId.startsWith('plant:start:')) {
      await handlePlantationStartButton(interaction, state, guildConfig);
      return;
    }

    if (interaction.customId.startsWith('plant:cycle:') ||
      interaction.customId.startsWith('plant:add4:') ||
      interaction.customId.startsWith('plant:finish:')) {
      await handlePlantationActionButton(interaction, state, guildConfig);
      return;
    }

    if (interaction.customId === 'main:estado') {
      const tasks = ensureTaskContainer(state, interaction.guildId);
      await interaction.reply({
        content: buildEstadoText(state, interaction.guildId, guildConfig, tasks),
        ephemeral: true
      });
      return;
    }

    if (interaction.customId === 'main:stats') {
      const range = resolveStatsRange({ rangeKey: '7d' });
      await interaction.reply({
        content: buildStatsText(state, interaction.guildId, range),
        components: buildStatsRangeMenu(),
        ephemeral: true
      });
      return;
    }

    if (interaction.customId === 'main:canales') {
      await interaction.reply({
        content: buildChannelAssignmentText(guildConfig),
        ephemeral: true
      });
      return;
    }

    // Legacy button kept for backward compatibility
    if (interaction.customId === 'main:plant-panel') {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }
      setMissionPanelRef(guildConfig, 'plantacion', null);
      await publishMissionPanel(interaction.guild, guildConfig, 'plantacion', { ignoreExisting: true });
      writeState(state);
      const channelId = getTaskChannelId(guildConfig, 'plantacion');
      await interaction.reply({
        content:
          `Panel de Plantacion recreado en ${formatAssignedChannel(channelId)}.\n` +
          'Si no lo ves, revisa permisos del bot en ese canal.',
        ephemeral: true
      });
      return;
    }

    // List pending evidence
    if (interaction.customId === 'main:list-evidence') {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }

      const pending = Object.entries(state.pendingEvidence).filter(
        ([, e]) => e.guildId === interaction.guildId
      );

      if (!pending.length) {
        await interaction.reply({ content: 'No hay evidencias pendientes.', ephemeral: true });
        return;
      }

      // Discord allows max 25 buttons (5 rows × 5 buttons)
      const displayPending = pending.slice(0, 25);
      const overflowCount = pending.length - displayPending.length;

      const lines = displayPending.map(
        ([, e]) =>
          `- <@${e.userId}> | **${e.taskType}** (${e.cooldownHours}h) | registrado <t:${Math.floor(e.createdAt / 1000)}:R>`
      );

      const buttons = displayPending.map(([key, e], idx) =>
        new ButtonBuilder()
          .setCustomId(`main:cancel-evidence:${key}`)
          .setLabel(`Cancelar #${idx + 1} ${e.taskType}`)
          .setStyle(ButtonStyle.Danger)
      );

      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
      }

      const overflowNote = overflowCount > 0 ? `\n_...y ${overflowCount} más (expiran automáticamente)._` : '';
      await interaction.reply({
        content: `## Evidencias pendientes\n${lines.join('\n')}${overflowNote}`,
        components: rows,
        ephemeral: true
      });
      return;
    }

    // Cancel specific pending evidence
    if (interaction.customId.startsWith('main:cancel-evidence:')) {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }
      const evidenceKey = interaction.customId.replace('main:cancel-evidence:', '');
      if (state.pendingEvidence[evidenceKey]) {
        const pendingEntry = state.pendingEvidence[evidenceKey];
        delete state.pendingEvidence[evidenceKey];
        writeState(state);
        await interaction.reply({
          content: `✅ Evidencia de <@${pendingEntry.userId}> (${pendingEntry.taskType}) cancelada.`,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: 'Esa evidencia ya no existe o fue procesada.',
          ephemeral: true
        });
      }
      return;
    }

    // Regenerate any mission panel
    if (interaction.customId.startsWith('main:regen-panel:')) {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }
      const taskKey = interaction.customId.replace('main:regen-panel:', '');
      const taskSettings = getTaskSettings(taskKey);
      if (!taskSettings) {
        await interaction.reply({ content: `Tipo de tarea no soportado: **${taskKey}**.`, ephemeral: true });
        return;
      }
      setMissionPanelRef(guildConfig, taskKey, null);
      await publishMissionPanel(interaction.guild, guildConfig, taskKey, { ignoreExisting: true });
      writeState(state);
      const channelId = getTaskChannelId(guildConfig, taskKey);
      await interaction.reply({
        content:
          `Panel de **${taskSettings.label}** recreado en ${formatAssignedChannel(channelId)}.\n` +
          'Si no lo ves, revisa permisos del bot en ese canal.',
        ephemeral: true
      });
      return;
    }

    // Clean mission channel
    if (interaction.customId.startsWith('main:clean:')) {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }
      const taskKey = interaction.customId.replace('main:clean:', '');
      const taskSettings = getTaskSettings(taskKey);
      if (!taskSettings) {
        await interaction.reply({ content: `Tipo de tarea no soportado: **${taskKey}**.`, ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const cleanResult = await cleanMissionChannel(interaction.guild, guildConfig, taskKey);

      if (cleanResult.error) {
        await interaction.editReply({ content: `Error al limpiar canal: ${cleanResult.error}` });
        return;
      }

      // Force re-publish panel at end of channel
      setMissionPanelRef(guildConfig, taskKey, null);
      try {
        await publishMissionPanel(interaction.guild, guildConfig, taskKey, { ignoreExisting: true });
        writeState(state);
      } catch (e) {
        console.error(`[clean] Error al republicar panel de ${taskKey}:`, e);
      }

      await interaction.editReply({
        content:
          `✅ Canal de **${taskSettings.label}** limpiado: **${cleanResult.deleted}** mensajes eliminados.\n` +
          'Panel de misión republicado al final del canal.'
      });
      return;
    }

    // Toggle Vender cyclic task
    if (interaction.customId === 'main:vender-toggle') {
      if (!isAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Solo administradores pueden usar esta accion.', ephemeral: true });
        return;
      }

      if (!guildConfig.vender) {
        guildConfig.vender = { active: false, nextNotificationAt: null, pendingDelete: null };
      }

      guildConfig.vender.active = !guildConfig.vender.active;

      if (guildConfig.vender.active) {
        // Send first notification immediately on next tick
        if (!guildConfig.vender.nextNotificationAt) {
          guildConfig.vender.nextNotificationAt = Date.now();
        }
        console.log(`[vender] guildId=${interaction.guildId} Notificacion Vender activada por ${interaction.user.tag}`);
      } else {
        guildConfig.vender.nextNotificationAt = null;
        console.log(`[vender] guildId=${interaction.guildId} Notificacion Vender detenida por ${interaction.user.tag}`);
      }

      writeState(state);
      await publishAdminPanel(interaction.guild, guildConfig);
      writeState(state);

      await interaction.reply({
        content: guildConfig.vender.active
          ? '✅ Notificación **Vender (Bolsa y Porro)** activada. Se enviará cada 40 min y se borrará a los 10 min.'
          : '⛔ Notificación **Vender (Bolsa y Porro)** detenida.',
        ephemeral: true
      });
      return;
    }

  } catch (error) {
    console.error(error);
    const fallback = { content: 'Ocurrio un error al procesar la accion.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(fallback).catch(() => null);
    } else {
      await interaction.reply(fallback).catch(() => null);
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[OK] Bot conectado como ${readyClient.user.tag} (${readyClient.user.id})`);
  setInterval(() => {
    schedulerTick().catch((err) => console.error('Scheduler error:', err));
  }, 30 * 1000);
});

(async () => {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error('No se pudo iniciar el bot:', error);
    process.exit(1);
  }
})();
