// Prueba el OCR sobre capturas reales sin tocar Discord.
//
//   npm run probar-ocr -- C:\ruta\a\capturas
//   npm run probar-ocr -- C:\ruta\a\una-captura.png
//
// Muestra, por cada imagen, la cifra detectada, la confianza y si el bot la
// contabilizaria o la marcaria para revision.
const fs = require('fs');
const path = require('path');
const { readAmountFromBuffer, formatAmount, terminateWorker, MIN_CONFIDENCE } = require('../src/ocr');

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

function collectImages(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return IMAGE_EXT.test(target) ? [target] : [];
  return fs
    .readdirSync(target)
    .filter((name) => IMAGE_EXT.test(name))
    .map((name) => path.join(target, name));
}

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.error('Indica una carpeta o una imagen:\n  npm run probar-ocr -- C:\\ruta\\a\\capturas');
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error(`No existe la ruta: ${target}`);
    process.exit(1);
  }

  const images = collectImages(target);
  if (!images.length) {
    console.error('No se encontraron imagenes en esa ruta.');
    process.exit(1);
  }

  console.log(`Procesando ${images.length} imagen(es). Umbral de confianza: ${MIN_CONFIDENCE}%\n`);

  let ok = 0;
  let review = 0;
  let failed = 0;

  for (const file of images) {
    const name = path.basename(file);
    try {
      const started = Date.now();
      const result = await readAmountFromBuffer(fs.readFileSync(file));
      const ms = Date.now() - started;

      if (result.amount === null) {
        failed += 1;
        console.log(`❌ ${name}\n   sin cifra — ${result.reason}\n   OCR leyo: ${JSON.stringify(result.text)}\n`);
      } else if (result.needsReview) {
        review += 1;
        console.log(
          `⚠️  ${name}\n   ${formatAmount(result.amount)} (revisar: ${result.reason})` +
          `\n   confianza ${result.confidence}% | ${ms} ms | OCR leyo: ${JSON.stringify(result.text)}\n`
        );
      } else {
        ok += 1;
        console.log(
          `✅ ${name}\n   ${formatAmount(result.amount)} — de "${result.raw}"` +
          `\n   confianza ${result.confidence}% | ${ms} ms\n`
        );
      }
    } catch (error) {
      failed += 1;
      console.log(`❌ ${name}\n   error: ${error.message}\n`);
    }
  }

  console.log('─'.repeat(50));
  console.log(`Contabilizadas: ${ok} | A revisar: ${review} | Fallidas: ${failed}`);
  if (review + failed > 0) {
    console.log('\nSi hay muchas a revisar, mandame la salida y ajusto el preprocesado.');
  }

  await terminateWorker();
})().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
