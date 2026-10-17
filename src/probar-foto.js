// Prueba el análisis de una foto sin Telegram y sin tocar la base de datos.
// Uso: npm run probar-foto -- ruta/a/foto.jpg
import fs from 'node:fs';
import path from 'node:path';
import { verificarVariables } from './config.js';
import { analizarFoto } from './vision.js';
import { calcularComida } from './nutrition.js';

const TIPOS_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const ruta = process.argv[2];
if (!ruta) {
  console.error('Uso: npm run probar-foto -- ruta/a/foto.jpg');
  process.exit(1);
}

const tipoMime = TIPOS_MIME[path.extname(ruta).toLowerCase()];
if (!tipoMime) {
  console.error(`Formato no soportado. Usá: ${Object.keys(TIPOS_MIME).join(', ')}`);
  process.exit(1);
}

verificarVariables(['ANTHROPIC_API_KEY', 'USDA_API_KEY']);

// Sin base de datos no hay contexto real del día, así que le pasamos uno vacío.
const analisis = await analizarFoto(fs.readFileSync(ruta), tipoMime, 'Sin datos (prueba desde la consola).');
const resultado = { analisis_claude: analisis };
if (analisis.tipo === 'comida' && analisis.items.length > 0) {
  resultado.comida = await calcularComida(analisis.items);
}

console.log(JSON.stringify(resultado, null, 2));
