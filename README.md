# Bot Mejorado (Discord)

Bot para gestionar tareas de:
- Maritimo
- Terrestre
- Runs
- Plantacion

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
   - Panel de Maritimo/Terrestre
   - Panel de Runs (incluye botones `Ver estado`, `Ver canales` y `Recrear panel Plantacion`)
4. Todos los reportes y notificaciones se enviaran por defecto al canal donde se ejecuto `/setup`.
5. Si quieres enviar cada tarea a canales distintos, usa:
   - `/asignar_canal tarea:Maritimo/Terrestre canal:#canal`
   - `/asignar_canal tarea:RUNS canal:#canal`
   - `/asignar_canal tarea:Plantacion canal:#canal`

## Flujo Rapido
- Maritimo/Terrestre: Maritimo tiene CD fijo de 24h y Terrestre CD fijo de 8h. Seleccionas una opcion, subes evidencia (foto) y el bot valida automaticamente la mision.
- Runs: mensaje unico persistente con estado y boton para iniciar/finalizar. Al terminar entra a CD 4h y luego notifica disponibilidad.
- Boton `Ver estado` en Main: muestra estado actual, quien hizo Maritimo/Terrestre y cuantos usuarios iniciaron RUNS.
- Boton `Ver canales` en Main: muestra a que canal responde cada tarea.
- Boton `Recrear panel Plantacion` en Main: vuelve a enviar el panel de Plantacion en su canal asignado.
- Plantacion: panel con botones `Ramas` y `Duplicado`.
- Flujo Plantacion `Ramas`: eliges `Ramas`, escribes cantidad de semillas, inicia ciclo 1/2 (3h cada ciclo), marcas cada ciclo, y al completar 2/2 aparece opcion para agregar un ciclo extra o finalizar.
- Flujo Plantacion `Duplicado`: eliges `Duplicado`, escribes cantidad de semillas y haces un ciclo unico de 3h para finalizar.
