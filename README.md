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
- **📊 Estadisticas** — Estadisticas generales por mision en un rango de tiempo
- **💵 Canales de dinero** — Asigna con desplegables el canal de lectura de fotos y el de reporte
- **Recrear panel MT/RUNS/Plantacion** — Fuerza republicar cada panel
- **Limpiar canal MT/RUNS/Plantacion** — Elimina mensajes viejos y republica el panel
- **▶️ Iniciar / ⛔ Detener Vender** — Controla la notificación cíclica de Vender

### Comando `/config_dinero`
Configura el conteo automático de dinero leyendo las fotos que envían los usuarios. Ver [Conteo automatico de dinero por fotos](#conteo-automatico-de-dinero-por-fotos).

### Paneles siempre como último mensaje
Los paneles de misión (MT, RUNS, Plantacion) se reposicionan automáticamente al final del canal si hay mensajes más recientes. El scheduler los verifica cada 30 segundos.

### Comando `/config_cd`
Permite a administradores cambiar el cooldown de cualquier tarea:
- `/config_cd tarea:Maritimo horas:24`
- `/config_cd tarea:Terrestre horas:8`
- `/config_cd tarea:RUNS horas:4`
- `/config_cd tarea:Plantacion (ciclo) horas:3`

### Estadisticas por mision y por periodo
Boton **📊 Estadisticas** del Panel de Administración, o comando `/estadisticas`.

Muestra, para cada mision (Marítimo, Terrestre, RUNS, Plantacion): total de misiones, usuarios distintos y ranking de quien la hizo. En RUNS ademas separa iniciadas / finalizadas / cerradas automaticamente; en Plantacion suma ciclos marcados y semillas usadas.

El resumen muestra los 10 primeros de cada mision. Para ver **todos** los usuarios usa el menu **"Ver lista completa de usuarios de..."**: abre el ranking completo de esa mision, paginado de 20 en 20, con botones `◀ Anterior`, `Siguiente ▶` y `↩ Volver al resumen`. El periodo elegido se mantiene al navegar.

El boton abre con los ultimos 7 dias y trae un menu para cambiar el periodo (24h, 7 dias, 30 dias, historico). Para rangos exactos usa el comando:
- `/estadisticas rango:Ultimas 24 horas`
- `/estadisticas desde:2026-08-01 hasta:2026-08-05`
- `/estadisticas desde:2026-08-01 14:00 hasta:2026-08-02 20:30`

Formatos aceptados: `YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, `DD/MM/YYYY`. Sin hora, `desde` toma las 00:00 y `hasta` las 23:59. Si llenas `desde`/`hasta`, tienen prioridad sobre `rango`. Las fechas se interpretan en la zona horaria del equipo donde corre el bot.

> Los datos salen del historial de reportes, limitado a los ultimos 3000 registros. El "historico completo" llega hasta ahi.

### Auto-cierre de RUNS
Si una RUNS lleva más de 1 hora en progreso sin ser finalizada manualmente, el bot la cierra automáticamente y aplica el CD configurado. Se registra en el log del servidor.

### Estado de RUNS con usuarios
El panel de RUNS muestra cuántos usuarios únicos han iniciado RUNS desde que se rastrean los datos.

## Flujo Plantacion
- **Ramas**: eliges `Ramas`, escribes cantidad de semillas, inicia ciclo 1/2 (3h por defecto por ciclo), marcas cada ciclo, y al completar 2/2 aparece opcion para agregar un ciclo extra o finalizar.
- **Duplicado**: eliges `Duplicado`, escribes cantidad de semillas y haces un ciclo unico de 3h para finalizar.

## Conteo automatico de dinero por fotos

El bot lee las capturas que los usuarios publican en un canal y reporta en otro canal quien envio y cuanto.

### Configuracion (desde el panel de administracion)
Pulsa **💵 Canales de dinero** en el panel del Main. Se abre un mensaje privado con dos desplegables:

- **📸 Canal de lectura**: donde los usuarios publican las fotos.
- **💵 Canal de reporte**: donde el bot avisa de quien envio y que cantidad detecto.

Eliges cada uno de la lista de canales del servidor y el panel se actualiza al momento indicando lo que falta. El boton **Desactivar el conteo** borra ambas asignaciones y detiene la lectura.

Puedes asignar solo uno de los dos y completar el otro despues. Si falta el de reporte, los avisos van al canal Main.

> Tambien existe el comando `/config_dinero lectura:#canal reporte:#canal` si prefieres escribirlo.

### Como funciona
1. Un usuario publica una foto en el canal de lectura.
2. El bot reacciona con ⏳ mientras la procesa (~0,5 s por imagen).
3. Publica en el canal de reporte: quien la envio, la cantidad y el enlace al mensaje original.
4. Marca el mensaje con ✅ si la conto, o ⚠️ si no pudo.

Lee sufijos: `440K` = 440.000, `1.2M` = 1.200.000. **La cifra con sufijo es el total**; el numero pequeño del stack no se multiplica. Tambien lee cifras completas sin sufijo (`802,164`).

Antes de leer, el bot **apaga los pixeles de color saturado** de la imagen. Las etiquetas de rareza del juego van en verde y se superponen a la cifra: en escala de grises se pegaban a los digitos y estropeaban la lectura. Con capturas de prueba superponiendo la etiqueta, el acierto limpio paso de 0 de 4 a 4 de 4, y la confianza media del 0% al 85%.

Las cantidades entran en `/estadisticas` como **Dinero enviado**, con total del periodo y ranking por usuario (suma de importes, no numero de entregas).

### Cuando pide revision
El bot **no suma** una lectura y la marca con ⚠️ cuando:
- La cifra no trae sufijo K/M. Un `440` que en realidad era `440K` se quedaria 1000 veces corto, asi que prefiere avisar antes que contar mal.
- La confianza del OCR sobre esa cifra baja del 60%.
- No encuentra ninguna cifra en la imagen.

Esas lecturas quedan registradas y se muestran aparte en las estadisticas, pero no suman al total.

### Probarlo en la verificacion visual
```
npm run preview
```
Abre la direccion que muestre (por defecto `http://localhost:4321`). La tarjeta **Conteo de dinero** deja arrastrar capturas reales y las procesa con el mismo OCR del bot: veras la cifra detectada, la confianza, el tiempo y el mensaje exacto que publicaria en el canal de reporte. Lo leido tambien alimenta la tarjeta de `Estadisticas`.

Si abres `preview/panel-preview.html` directamente (sin el servidor), el resto de la demo funciona pero el OCR no: la tarjeta lo avisa.

### Calibrar con tus capturas
El acierto depende de como se vean tus imagenes. Antes de confiar en el conteo, pasa unas cuantas capturas reales por:

```
npm run probar-ocr -- C:\ruta\a\capturas
```

Muestra por cada imagen la cifra detectada, la confianza y si se contabilizaria. Si salen muchas a revisar, hay margen para ajustar el preprocesado.

> El OCR es local y gratuito (`tesseract.js`), sin API ni coste por imagen. La primera ejecucion descarga ~15 MB de datos de idioma y los cachea en tu carpeta de datos; a partir de ahi funciona sin internet.

## Conservar los datos entre actualizaciones

El bot guarda todo (configuracion, cooldowns, historial de reportes) en `state.json`. Hay dos protecciones:

**1. Guarda tu base de datos fuera del proyecto.** Configura `DATA_DIR` en tu `.env` con una ruta que NO este dentro de la carpeta del bot:

```
DATA_DIR=C:\BotMejoradoDatos       # Windows
DATA_DIR=/var/lib/bot-mejorado     # Linux
```

Asi puedes reemplazar, reinstalar o volver a clonar la carpeta del bot sin perder nada. Si dejas `DATA_DIR` vacio, los datos viven en `data/` dentro del proyecto y **se pierden si reemplazas la carpeta al actualizar**. El bot avisa de esto en consola al arrancar.

**2. Respaldo automatico y escritura segura.** El estado se escribe primero en un archivo temporal y luego se reemplaza de golpe, asi que apagar el bot a mitad de un guardado ya no puede corromper el archivo. Ademas se mantiene `state.backup.json`, y si `state.json` aparece corrupto o vacio, el bot **restaura desde el respaldo** en vez de arrancar en blanco. El archivo dañado se conserva como `state.corrupto-<fecha>.json` por si quieres revisarlo.

> Al arrancar, el bot imprime donde vive la base de datos y cuantos servidores y reportes cargo. Si ves `0 servidor(es), 0 reporte(s)` cuando esperabas datos, estas apuntando a la carpeta equivocada.

### Antes de actualizar
1. Para el bot.
2. Copia tu carpeta de datos (la que indique el log de arranque) a un lugar seguro.
3. Actualiza el codigo.
4. Arranca y confirma en el log que cargo tus servidores y reportes.

## Verificacion Visual
Abre `preview/panel-preview.html` en el navegador para simular los paneles sin Discord: Maritimo/Terrestre, RUNS, Plantacion, asignacion de canales y los botones del Main (`Ver estado`, `Ver canales`, `Recrear panel Plantacion`, `Estadisticas`).

La tarjeta de `Estadisticas` trae historial simulado de los ultimos 30 dias para que el filtro por periodo se note, y se actualiza en vivo con lo que hagas en la demo. Los tiempos estan acelerados (CD de RUNS = 40s, ciclos de plantacion = 25s). `Recrear todo` reinicia el estado y regenera el historial simulado.

> El preview todavia no simula las funciones mas nuevas (Vender, Evidencias pendientes, Limpiar canal).
