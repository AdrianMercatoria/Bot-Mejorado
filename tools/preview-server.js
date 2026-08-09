// Servidor local para la verificacion visual.
//
//   npm run preview
//
// Sirve preview/panel-preview.html y expone /api/ocr, que ejecuta EL MISMO
// modulo de OCR que usa el bot. Asi puedes soltar tus capturas reales y ver
// exactamente lo que haria en Discord, sin token ni servidor.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { readAmountFromBuffer, formatAmount, MIN_CONFIDENCE } = require('../src/ocr');

const PORT = Number(process.env.PREVIEW_PORT) || 4321;
const PREVIEW_FILE = path.join(__dirname, '..', 'preview', 'panel-preview.html');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('La imagen es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleOcr(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    send(res, 400, JSON.stringify({ error: error.message || 'Cuerpo invalido.' }));
    return;
  }

  const dataUrl = payload?.dataUrl;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    send(res, 400, JSON.stringify({ error: 'Falta una imagen valida.' }));
    return;
  }

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    send(res, 400, JSON.stringify({ error: 'La imagen esta vacia.' }));
    return;
  }

  try {
    const started = Date.now();
    const result = await readAmountFromBuffer(buffer);
    send(
      res,
      200,
      JSON.stringify({
        ...result,
        formatted: result.amount === null ? null : formatAmount(result.amount),
        ms: Date.now() - started,
        threshold: MIN_CONFIDENCE
      })
    );
  } catch (error) {
    console.error('[preview] OCR fallo:', error.message);
    send(res, 500, JSON.stringify({ error: error.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/ocr') {
    await handleOcr(req, res);
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/panel-preview.html')) {
    fs.readFile(PREVIEW_FILE, (error, data) => {
      if (error) {
        send(res, 500, `No se pudo leer ${PREVIEW_FILE}: ${error.message}`, 'text/plain; charset=utf-8');
        return;
      }
      send(res, 200, data, 'text/html; charset=utf-8');
    });
    return;
  }

  send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
});

server.listen(PORT, () => {
  console.log(`\n  Verificacion visual lista en:  http://localhost:${PORT}\n`);
  console.log('  La tarjeta "Conteo de dinero" ejecuta el OCR real del bot.');
  console.log('  Suelta ahi tus capturas para ver que cantidad detectaria.\n');
  console.log('  Ctrl+C para parar.\n');
});
