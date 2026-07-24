# Bot Mejorado (Discord)

Bot para gestionar tareas de:
- Maritimo
- Terrestre
- Runs
- Plantacion
- Vender (Bolsa y Porro) — tarea cíclica automática

## Inicio rápido

1. **Instala dependencias:**
   ```bash
   npm install
   ```

2. **Crea tu `.env`** copiando el ejemplo:
   ```bash
   cp .env.example .env
   ```
   Luego edita `.env` y completa los valores:
   | Variable | Requerida | Descripción |
   |---|---|---|
   | `DISCORD_TOKEN` | ✅ Sí | Token del bot (Discord Developer Portal → Bot → Token) |
   | `CLIENT_ID` | ✅ Sí | Application ID del bot (Discord Developer Portal → General Information) |
   | `GUILD_ID` | ⬜ Opcional | ID del servidor de Discord para registro de comandos inmediato |

   > **Nota sobre propagación de comandos:**
   > - Con `GUILD_ID` configurado: los slash commands aparecen en el servidor **de inmediato**. Ideal para desarrollo y pruebas.
   > - Sin `GUILD_ID`: los comandos se registran globalmente y pueden tardar **hasta 1 hora** en reflejarse en Discord.

3. **Configura los intents y permisos del bot en Discord Developer Portal:**
   - En **Bot → Privileged Gateway Intents**, activa:
     - **Message Content Intent**
   - Al invitar el bot a tu servidor, asegúrate de usar los scopes `bot` + `applications.commands` con permisos de: enviar mensajes, leer historial de mensajes y gestionar mensajes.

4. **Inicia el bot:**
   ```bash
   npm start
   ```

## Requisitos
- Node.js 18+
- Un bot de Discord con permisos para enviar mensajes, usar slash commands, y gestionar mensajes del canal.

## Instalacion
1. Instala dependencias:
   - `npm install`
2. Crea `.env` desde `.env.example` y completa:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (opcional, para comandos inmediatos en tu servidor)
3. Inicia el bot:
   - `npm start`

## Configuracion Inicial
1. Ve al canal que quieras usar como Main.
2. Ejecuta `/setup`.
3. El bot creara:
   - Panel de Marítimo/Terrestre
   - Panel de RUNS (solo botones **Iniciar** y **Terminar**)
   - Panel de Plantacion
   - **Panel de Administración** (con todos los controles de admin)
4. Todos los reportes y notificaciones se enviaran por defecto al canal donde se ejecuto `/setup`.
5. Si quieres enviar cada tarea a canales distintos, usa:
   - `/asignar_canal tarea:Maritimo/Terrestre canal:#canal`
   - `/asignar_canal tarea:RUNS canal:#canal`
   - `/asignar_canal tarea:Plantacion canal:#canal`

## Flujo Rapido
- **Maritimo/Terrestre**: Seleccionas una opcion, subes evidencia (foto) y el bot valida automaticamente la mision. CD configurable con `/config_cd`.
- **RUNS**: Panel simplificado con solo **Iniciar** y **Terminar**. Al terminar entra a CD (4h por defecto) y luego notifica disponibilidad. Auto-cierre a 1 hora si no se termina manualmente.
- **Plantacion**: Panel con botones `Ramas` y `Duplicado`.
- **Vender (Bolsa y Porro)**: Notificación cíclica a @everyone cada 40 minutos. El mensaje se borra automaticamente a los 10 minutos. Se controla desde el Panel de Administración.

## Nuevas Funciones (Admin)

### Panel de Administración
Publicado automáticamente en el canal Main. Contiene:
- **Ver estado** — Estado actual de todas las tareas
- **Ver canales** — Canales asignados por tarea
- **Evidencias pendientes** — Lista y permite cancelar evidencias no enviadas
- **Recrear panel MT/RUNS/Plantacion** — Fuerza republicar cada panel
- **Limpiar canal MT/RUNS/Plantacion** — Elimina mensajes viejos y republica el panel
- **▶️ Iniciar / ⛔ Detener Vender** — Controla la notificación cíclica de Vender

### Paneles siempre como último mensaje
Los paneles de misión (MT, RUNS, Plantacion) se reposicionan automáticamente al final del canal si hay mensajes más recientes. El scheduler los verifica cada 30 segundos.

### Comando `/config_cd`
Permite a administradores cambiar el cooldown de cualquier tarea:
- `/config_cd tarea:Maritimo horas:24`
- `/config_cd tarea:Terrestre horas:8`
- `/config_cd tarea:RUNS horas:4`
- `/config_cd tarea:Plantacion (ciclo) horas:3`

### Auto-cierre de RUNS
Si una RUNS lleva más de 1 hora en progreso sin ser finalizada manualmente, el bot la cierra automáticamente y aplica el CD configurado. Se registra en el log del servidor.

### Estado de RUNS con usuarios
El panel de RUNS muestra cuántos usuarios únicos han iniciado RUNS desde que se rastrean los datos.

## Flujo Plantacion
- **Ramas**: eliges `Ramas`, escribes cantidad de semillas, inicia ciclo 1/2 (3h por defecto por ciclo), marcas cada ciclo, y al completar 2/2 aparece opcion para agregar un ciclo extra o finalizar.
- **Duplicado**: eliges `Duplicado`, escribes cantidad de semillas y haces un ciclo unico de 3h para finalizar.
