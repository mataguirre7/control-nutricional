// Revisa las comidas ya guardadas con la estimación actual y muestra cuáles cambiarían.
// Sirve para corregir lo que se calculó mal antes de un arreglo en la estimación.
//
// Uso (en el VPS, dentro del contenedor):
//   npm run revisar-comidas                → solo muestra los cambios, no toca nada
//   npm run revisar-comidas -- --aplicar   → además corrige las comidas que cambian
//
// Mantiene los gramos guardados (pueden venir de una corrección con "Era más" o "Era menos")
// y vuelve a calcular los nutrientes. Cada comida es una llamada a Claude: unos centavos cada una.
import { verificarVariables } from './config.js';
import { prepararBase, cerrarBase, todasLasComidas, reemplazarComida, obtenerUsuario } from './db.js';
import { reestimarAlimentos } from './vision.js';
import { calcularComida, esConsistente } from './nutrition.js';
import { recalcularHistorial } from './progreso.js';

// Una comida se marca para corregir si sus calorías cambian más que esto.
const CAMBIO_MINIMO = 0.2;

// Dos comidas de la misma persona con menos de esta diferencia pueden ser la misma anotada dos veces.
const MINUTOS_POSIBLE_DUPLICADA = 60;

const aplicar = process.argv.includes('--aplicar');
verificarVariables(['ANTHROPIC_API_KEY', 'USDA_API_KEY', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']);
await prepararBase();

const comidas = await todasLasComidas();
console.log(`Revisando ${comidas.length} comidas${aplicar ? ' (se corrigen las que cambian)' : ' (solo se muestran: no se cambia nada)'}...\n`);

function minutosEntre(fechaHoraA, fechaHoraB) {
  return Math.abs(new Date(fechaHoraA.replace(' ', 'T')) - new Date(fechaHoraB.replace(' ', 'T'))) / 60000;
}

const aCorregir = [];
const sinRevisar = [];
for (const comida of comidas) {
  const titulo = `#${comida.id} · ${comida.chatId} · ${comida.fecha_hora} · ${comida.tipo_comida}`;
  try {
    const alimentos = await reestimarAlimentos(comida.items.map((item) => ({ nombre: item.nombre, gramos: item.gramos })));
    if (!alimentos) {
      sinRevisar.push(titulo);
      console.log(`?  ${titulo}: Claude no devolvió los mismos alimentos, la salteo\n`);
      continue;
    }
    const nueva = await calcularComida(alimentos);
    const antes = comida.totales.kcal;
    const despues = nueva.totales.kcal;
    const cambio = Math.abs(despues - antes) / Math.max(antes, 1);
    const inconsistentes = comida.items.filter((item) => !esConsistente(item.nutrientes)).length;

    const marca = cambio > CAMBIO_MINIMO ? '✗ ' : '✓ ';
    console.log(`${marca}${titulo}: ${Math.round(antes)} → ${Math.round(despues)} kcal (${Math.round(cambio * 100)}% de diferencia)`);
    comida.items.forEach((item, i) => {
      const nuevoItem = nueva.items[i];
      const densidadAntes = Math.round((item.nutrientes.kcal / item.gramos) * 100);
      const densidadDespues = Math.round((nuevoItem.nutrientes.kcal / nuevoItem.gramos) * 100);
      console.log(
        `     ${item.nombre}, ${Math.round(item.gramos)} g: ${Math.round(item.nutrientes.kcal)} → ${Math.round(nuevoItem.nutrientes.kcal)} kcal` +
          ` (${densidadAntes} → ${densidadDespues} kcal cada 100 g, ${item.fuente} → ${nuevoItem.fuente})`
      );
    });
    if (inconsistentes > 0) console.log(`     ${inconsistentes} alimento(s) guardados con kcal que no cuadraban con sus macros`);
    console.log('');

    if (cambio > CAMBIO_MINIMO) aCorregir.push({ comida, nueva });
  } catch (error) {
    sinRevisar.push(titulo);
    console.log(`?  ${titulo}: no pude revisarla (${error.message})\n`);
  }
}

// Posibles duplicadas: solo se avisan, porque dos comidas seguidas también pueden ser reales.
const posiblesDuplicadas = [];
for (let i = 1; i < comidas.length; i++) {
  const [a, b] = [comidas[i - 1], comidas[i]];
  if (a.chatId === b.chatId && minutosEntre(a.fecha_hora, b.fecha_hora) < MINUTOS_POSIBLE_DUPLICADA) {
    posiblesDuplicadas.push(`#${a.id} y #${b.id} (${a.chatId}, ${a.fecha_hora} y ${b.fecha_hora})`);
  }
}

console.log('---------- Resumen ----------');
console.log(`Revisadas: ${comidas.length - sinRevisar.length} de ${comidas.length}`);
console.log(`Con más de ${CAMBIO_MINIMO * 100}% de diferencia: ${aCorregir.length}`);
if (sinRevisar.length > 0) console.log(`No se pudieron revisar: ${sinRevisar.join(' | ')}`);
if (posiblesDuplicadas.length > 0) {
  console.log(`Posibles duplicadas (revisalas a mano; se borran con el botón 🗑️ o desde DBeaver): ${posiblesDuplicadas.join(' | ')}`);
}

if (aplicar && aCorregir.length > 0) {
  for (const { comida, nueva } of aCorregir) {
    await reemplazarComida(comida.id, nueva);
  }
  // Con las comidas corregidas, se recalcula el progreso de grasa de cada persona afectada.
  for (const chatId of new Set(aCorregir.map(({ comida }) => comida.chatId))) {
    await recalcularHistorial(await obtenerUsuario(chatId));
  }
  console.log(`\nListo: corregí ${aCorregir.length} comida(s) y recalculé el progreso.`);
} else if (aCorregir.length > 0) {
  console.log('\nNo cambié nada. Para corregirlas: npm run revisar-comidas -- --aplicar');
}

await cerrarBase();
