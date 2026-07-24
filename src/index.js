require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
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
          { name: 'Plantacion', value: 'plantacion' }
        )
    )
    .addChannelOption((opt) =>
      opt
        .setName('canal')
        .setDescription('Canal de respuesta para la tarea')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
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
  }
};

const TASK_ALIASES = {
  maritimo_terrestre: 'maritimo_terrestre',
  'maritimo-terrestre': 'maritimo_terrestre',
  maritime_terrestrial: 'maritimo_terrestre',
  runs: 'runs',
  plantacion: 'plantacion',
  plantation: 'plantacion'
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
      maritimeTerrestrialPanelMessageId: null,
      runsPanelMessageId: null,
      plantationPanelMessageId: null,
      responseChannels: {},
      missionPanels: {},
      runs: {
        status: 'available',
        cooldownEndsAt: null,
        notifiedReady: false
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

function buildMainTaskButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('mt:maritimo:24')
        .setLabel('Maritimo (24h)')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('mt:terrestre:8')
        .setLabel('Terrestre (8h)')
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

function buildMainStatusButtons() {
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
        .setCustomId('main:plant-panel')
        .setLabel('Recrear panel Plantacion')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function getTaskChannelId(guildConfig, taskKey) {
  ensureGuildPanelState(guildConfig);
  const normalizedTaskKey = normalizeTaskKey(taskKey);
  const settings = getTaskSettings(normalizedTaskKey);
  if (settings) {
    return guildConfig.responseChannels[normalizedTaskKey] || guildConfig[settings.channelField] || guildConfig.mainChannelId || null;
  }
  return guildConfig.mainChannelId || null;
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

  return [
    '### Canales de respuesta',
    `- Maritimo/Terrestre -> ${formatAssignedChannel(mtChannelId)}`,
    `- RUNS -> ${formatAssignedChannel(runsChannelId)}`,
    `- Plantacion -> ${formatAssignedChannel(plantationChannelId)}`
  ].join('\n');
}

async function buildRunsPanelText(guildConfig) {
  const runs = guildConfig.runs;
  if (runs.status === 'available') {
    return '## RUNS\nEstado: **DISPONIBLE**\nPresiona **Iniciar** cuando comiencen.';
  }
  if (runs.status === 'in_progress') {
    return '## RUNS\nEstado: **EN PROGRESO**\nCuando finalice, presiona **Terminar**.';
  }

  const left = Math.max(0, (runs.cooldownEndsAt || 0) - Date.now());
  return `## RUNS\nEstado: **EN CD (4h)**\nTiempo restante: **${formatDuration(left)}**`;
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

function buildMaritimeTerrestrialPanelPayload() {
  return {
    content:
      '## Marítimo / Terrestre\n' +
      'Marítimo tiene CD fijo de 24h y Terrestre CD fijo de 8h.\n' +
      'Selecciona uno y luego sube la evidencia (foto). La mision se valida automaticamente.',
    components: buildMainTaskButtons()
  };
}

async function buildRunsPanelPayload(guildConfig) {
  return {
    content: await buildRunsPanelText(guildConfig),
    components: [...buildRunsButtons(guildConfig.runs.status), ...buildMainStatusButtons()]
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
    return buildMaritimeTerrestrialPanelPayload();
  }
  if (normalizedTaskKey === 'runs') {
    return buildRunsPanelPayload(guildConfig);
  }
  if (normalizedTaskKey === 'plantacion') {
    return buildPlantationPanelPayload(guildConfig);
  }
  throw new Error(`Tipo de panel no soportado: ${taskKey}`);
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

  if (previousRef?.messageId && previousRef.channelId === targetChannel.id) {
    const previousMessage = await targetChannel.messages.fetch(previousRef.messageId).catch(() => null);
    if (previousMessage) {
      try {
        panelMessage = await previousMessage.edit(payload);
        action = 'edit';
      } catch (error) {
        if (options.logPrefix) {
          console.warn(`${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} action=edit_failed`, error);
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

  if (options.logPrefix) {
    console.log(`${options.logPrefix} tipo=${normalizedTaskKey} canal=${targetChannel.id} action=${action}`);
  }

  return {
    action,
    channelId: targetChannel.id,
    messageId: panelMessage.id,
    cleanedPrevious
  };
}

async function setupPanels(interaction, state, guildConfig) {
  const channel = interaction.channel;

  guildConfig.mainChannelId = channel.id;
  setTaskChannelId(guildConfig, 'maritimo_terrestre', channel.id);
  setTaskChannelId(guildConfig, 'runs', channel.id);
  if (!getTaskChannelId(guildConfig, 'plantacion')) {
    setTaskChannelId(guildConfig, 'plantacion', channel.id);
  }

  await publishMissionPanel(interaction.guild, guildConfig, 'maritimo_terrestre');
  await publishMissionPanel(interaction.guild, guildConfig, 'runs');
  await ensurePlantationPanel(interaction.guild, guildConfig);

  writeState(state);
}

async function refreshRunsPanel(guild, guildConfig) {
  if (!getTaskChannelId(guildConfig, 'runs')) return;
  await publishMissionPanel(guild, guildConfig, 'runs');
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
  await publishMissionPanel(guild, guildConfig, 'plantacion');
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

    await notifyRunsChannel(interaction.guild, guildConfig, `🚀 ${interaction.user} inicio una RUNS.`);
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

    runs.status = 'cooldown';
    runs.cooldownEndsAt = addHours(4);
    runs.notifiedReady = false;

    addReport(state, {
      kind: 'runs_finish',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      createdAt: Date.now()
    });

    writeState(state);

    await interaction.reply({
      content: 'RUNS finalizada. CD de 4h iniciado.',
      ephemeral: true
    });

    await notifyRunsChannel(
      interaction.guild,
      guildConfig,
      `⏳ ${interaction.user} finalizo RUNS. Queda en cooldown por 4 horas.`
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
      task.nextCycleEndsAt = addHours(3);
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
    task.nextCycleEndsAt = addHours(3);
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

    await refreshPlantationPanel(guild, guildConfig);

    if (guildConfig.runs.status === 'cooldown' && guildConfig.runs.cooldownEndsAt && now >= guildConfig.runs.cooldownEndsAt) {
      if (!guildConfig.runs.notifiedReady) {
        await notifyRunsChannel(guild, guildConfig, '🔔 @everyone RUNS esta disponible nuevamente.');
      }
      guildConfig.runs.status = 'available';
      guildConfig.runs.cooldownEndsAt = null;
      guildConfig.runs.notifiedReady = true;
      changed = true;
      await refreshRunsPanel(guild, guildConfig);
    } else if (guildConfig.runs.status === 'cooldown') {
      await refreshRunsPanel(guild, guildConfig);
    } else {
      await refreshRunsPanel(guild, guildConfig);
    }

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

  }

  if (changed) {
    writeState(state);
  } else {
    // Save if pending evidence cleanup removed entries.
    writeState(state);
  }
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
      nextCycleEndsAt: addHours(3)
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
          'Canal Main configurado y paneles creados.\n' +
          'Este canal recibira reportes y notificaciones automáticas.\n' +
          'Puedes reasignar canales con /asignar_canal.',
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

      let panelStatusText = 'La asignación se guardó, pero no pude publicar el panel. Revisa permisos del bot en ese canal.';
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

      await interaction.reply({
        content:
          `Asignación actualizada para **${taskSettings.label}** en ${targetChannel}.\n` +
          `${panelStatusText}\n\n` +
          buildChannelAssignmentText(guildConfig),
        ephemeral: true
      });
      return;
    }
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

    if (interaction.customId === 'main:canales') {
      await interaction.reply({
        content: buildChannelAssignmentText(guildConfig),
        ephemeral: true
      });
      return;
    }

    if (interaction.customId === 'main:plant-panel') {
      setMissionPanelRef(guildConfig, 'plantacion', null);
      await publishMissionPanel(interaction.guild, guildConfig, 'plantacion');
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
