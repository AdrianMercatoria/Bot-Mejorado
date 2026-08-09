const path = require('path');
const { createWorker, OEM, PSM } = require('tesseract.js');
const { Jimp } = require('jimp');

// Los datos de idioma de tesseract se descargan una vez y quedan cacheados aqui.
const CACHE_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

// El texto de la captura es pequeño; ampliarlo antes del OCR sube mucho el acierto.
const TARGET_WIDTH = 1200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Por debajo de esto la lectura se marca para revision manual.
const MIN_CONFIDENCE = 60;

const MULTIPLIERS = { K: 1000, M: 1000000, B: 1000000000 };

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng', OEM.LSTM_ONLY, { cachePath: CACHE_DIR });
      await worker.setParameters({
        // Solo lo que puede aparecer en una cifra: evita que invente letras.
        tessedit_char_whitelist: '0123456789.,KMBkmbxX',
        tessedit_pageseg_mode: PSM.SPARSE_TEXT
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function terminateWorker() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate().catch(() => null);
}

async function preprocess(buffer) {
  const image = await Jimp.read(buffer);

  if (image.bitmap.width < TARGET_WIDTH) {
    const scale = TARGET_WIDTH / image.bitmap.width;
    image.resize({ w: TARGET_WIDTH, h: Math.round(image.bitmap.height * scale) });
  }

  // Escala de grises + contraste separa el texto claro del fondo oscuro del juego.
  image.greyscale().contrast(0.5);

  return image.getBuffer('image/png');
}

// El OCR confunde letras con digitos dentro de una cifra. Solo corregimos
// dentro de tokens que ya contienen numeros, para no romper texto normal.
function fixDigitConfusions(token) {
  return token
    .replace(/[Oo]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Zz]/g, '2');
}

function toNumber(rawDigits, suffix) {
  let digits = rawDigits;

  if (suffix) {
    // Con sufijo, una coma o punto es separador decimal: "1.2M" = 1200000.
    digits = digits.replace(',', '.');
    const parts = digits.split('.');
    if (parts.length > 2) digits = `${parts.shift()}.${parts.join('')}`;
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * MULTIPLIERS[suffix]);
  }

  // Sin sufijo, separadores de miles: "440,000" = 440000.
  const value = Number.parseInt(digits.replace(/[.,\s]/g, ''), 10);
  return Number.isFinite(value) ? value : null;
}

function formatAmount(value) {
  return value.toLocaleString('es-ES');
}

function normalizeToken(token) {
  return /\d/.test(token) ? fixDigitConfusions(token) : token;
}

// Recorre la estructura de bloques de tesseract para sacar palabra + confianza.
// La confianza global no sirve: el nombre del item y las etiquetas la hunden
// aunque la cifra se haya leido perfectamente.
function extractWords(data) {
  const words = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = (word?.text || '').trim();
          if (text) words.push({ text, confidence: Math.round(word.confidence || 0) });
        }
      }
    }
  }
  return words;
}

function collectCandidates(pieces) {
  const suffixed = [];
  const plain = [];

  for (const piece of pieces) {
    const normalized = piece.text
      .split(' ')
      .map(normalizeToken)
      .join(' ');

    let match;
    const withSuffix = /(\d[\d.,]*)\s*([KMBkmb])/g;
    while ((match = withSuffix.exec(normalized)) !== null) {
      const value = toNumber(match[1], match[2].toUpperCase());
      if (value !== null && value > 0) {
        suffixed.push({ value, raw: match[0].trim(), confidence: piece.confidence });
      }
    }

    if (suffixed.length) continue;

    const bare = /\d[\d.,]*/g;
    while ((match = bare.exec(normalized)) !== null) {
      const value = toNumber(match[0], null);
      if (value !== null && value > 0) {
        plain.push({
          value,
          raw: match[0],
          confidence: piece.confidence,
          complete: isCompleteNumber(match[0], value)
        });
      }
    }
  }

  return { suffixed, plain };
}

// Una cifra sin sufijo puede ser completa ("802,164") o el principio de una
// abreviada a la que el OCR se comio la K ("440" por "440K"). La distinguimos
// por la forma: agrupacion de miles o magnitud suficiente = completa.
function isCompleteNumber(raw, value) {
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) return true; // 802,164 / 1.234.567
  if (/^\d+$/.test(raw) && value >= 1000) return true; // 802164
  return false;
}

/**
 * Extrae la cantidad de un texto de OCR.
 * Prefiere siempre una cifra con sufijo (440K). Si solo hay numeros sueltos
 * devuelve el mayor pero marca needsReview, porque un "440" que en realidad
 * era "440K" se quedaria 1000 veces corto.
 *
 * `words` es opcional: cuando viene, la confianza se toma de la palabra que
 * produjo la cifra en vez de la media de toda la imagen.
 */
function parseAmount(rawText, words = []) {
  const text = (rawText || '').replace(/\s+/g, ' ').trim();
  const hasWords = Array.isArray(words) && words.length > 0;

  if (!text && !hasWords) {
    return { amount: null, needsReview: true, reason: 'El OCR no devolvio texto.' };
  }

  // Primero por palabras (con su confianza); si no dan nada, sobre el texto
  // completo, por si la cifra quedo partida entre dos palabras.
  let { suffixed, plain } = collectCandidates(hasWords ? words : [{ text, confidence: null }]);
  if (!suffixed.length && !plain.length && hasWords && text) {
    ({ suffixed, plain } = collectCandidates([{ text, confidence: null }]));
  }

  if (suffixed.length) {
    const best = suffixed.reduce((a, b) => (b.value > a.value ? b : a));
    return {
      amount: best.value,
      needsReview: false,
      raw: best.raw,
      hadSuffix: true,
      tokenConfidence: best.confidence
    };
  }

  if (!plain.length) {
    return { amount: null, needsReview: true, reason: 'No se encontro ninguna cifra en la imagen.' };
  }

  // Preferimos una cifra completa aunque otra suelta sea mayor: "2 802,164"
  // debe dar 802.164, no quedarse con un fragmento.
  const complete = plain.filter((p) => p.complete);
  if (complete.length) {
    const best = complete.reduce((a, b) => (b.value > a.value ? b : a));
    return {
      amount: best.value,
      needsReview: false,
      raw: best.raw,
      hadSuffix: false,
      tokenConfidence: best.confidence
    };
  }

  const best = plain.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    amount: best.value,
    needsReview: true,
    raw: best.raw,
    hadSuffix: false,
    tokenConfidence: best.confidence,
    reason: 'La cifra no traia sufijo (K/M) ni separador de miles. Puede faltarle un multiplicador.'
  };
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No se pudo descargar la imagen (HTTP ${response.status})`);
  }

  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new Error('La imagen es demasiado grande para procesarla.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('La imagen es demasiado grande para procesarla.');
  }
  return buffer;
}

// El OCR consume bastante CPU. Encadenamos las lecturas para que varias fotos
// seguidas no bloqueen el bot ni compitan por el mismo worker.
let queue = Promise.resolve();

function enqueue(task) {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function runRecognition(buffer) {
  const processed = await preprocess(buffer);
  const worker = await getWorker();
  const { data } = await worker.recognize(processed, {}, { blocks: true, text: true });

  const words = extractWords(data);
  const result = parseAmount(data.text, words);

  // La confianza que importa es la de la cifra, no la media de la imagen.
  result.confidence =
    typeof result.tokenConfidence === 'number'
      ? result.tokenConfidence
      : Math.round(data.confidence || 0);
  result.text = (data.text || '').replace(/\s+/g, ' ').trim();

  if (result.amount !== null && result.confidence < MIN_CONFIDENCE) {
    result.needsReview = true;
    result.reason = result.reason || `Confianza baja del OCR (${result.confidence}%).`;
  }

  return result;
}

function readAmountFromBuffer(buffer) {
  return enqueue(() => runRecognition(buffer));
}

async function readAmountFromUrl(url) {
  const buffer = await downloadImage(url);
  return readAmountFromBuffer(buffer);
}

module.exports = {
  readAmountFromUrl,
  readAmountFromBuffer,
  parseAmount,
  formatAmount,
  terminateWorker,
  MIN_CONFIDENCE
};
