// Cálculos de progreso (barras, rachas, logros, tendencia de peso) y armado de los
// mensajes que ve cada persona. Todo en texto plano, sin formato, para que se lea simple.
//
// Casi todas las funciones reciben "usuario": { chatId, nombre, pesoObjetivo, metaKcal, metaAguaMl }
// (lo arma obtenerUsuario en db.js), porque cada persona tiene sus propios datos y metas.
// Las que leen la base son async; las de formato y cálculo puro, no.
import {
  sumarDias,
  aguaDelDia,
  diasConMetaDeAgua,
  kcalDelDia,
  diasConComidas,
  comidasDelDia,
  ultimoPeso,
  ultimoPesoDelDia,
  primerPeso,
  promedioPeso,
} from './db.js';

// Rachas que merecen un festejo especial.
const HITOS_RACHA = [3, 7, 14, 21, 30, 60, 90, 180, 365];

// ---------- Formato de números ----------

// Redondea a un decimal para no mostrar restos como -0.4000000001.
export function unDecimal(valor) {
  return Math.round(valor * 10) / 10;
}

// 102.14 → "102,1"
export function enKg(valor) {
  return valor.toLocaleString('es-AR', { maximumFractionDigits: 1 });
}

// 1250 → "1,25"
export function enLitros(ml) {
  return (ml / 1000).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// 1320.4 → "1.320"
export function enKcal(kcal) {
  return Math.round(kcal).toLocaleString('es-AR');
}

// "2026-10-16" → "16/10"
function diaYMes(fecha) {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;
}

// ---------- Metas ----------

export function textoMetas(usuario) {
  const peso = usuario.pesoObjetivo ? `${enKg(usuario.pesoObjetivo)} kg` : 'sin definir';
  const kcal = usuario.metaKcal ? `${enKcal(usuario.metaKcal)} kcal por día` : 'sin definir';
  return [
    'Tus metas:',
    `⚖️ Peso: ${peso}`,
    `🍽️ Calorías: ${kcal}`,
    `💧 Agua: ${enLitros(usuario.metaAguaMl)} L por día`,
    '',
    'Para cambiarlas, escribime por ejemplo:',
    '"quiero llegar a 85 kilos"',
    '"quiero comer 1600 calorías por día"',
    '"quiero tomar 2 litros de agua por día"',
  ].join('\n');
}

// ---------- Barras de progreso ----------

// barra(1150, 1600, '🟩') → "🟩🟩🟩🟩🟩🟩⬜⬜" (8 casilleros)
function barra(actual, meta, simbolo) {
  const casilleros = 8;
  const llenos = Math.min(casilleros, Math.round((actual / meta) * casilleros));
  return simbolo.repeat(llenos) + '⬜'.repeat(casilleros - llenos);
}

// Sin meta de calorías mostramos solo el número.
// Si se pasa de la meta, la barra cambia de color pero sin retarla.
export function lineaKcal(kcal, usuario) {
  if (!usuario.metaKcal) {
    return `Total del día: ${enKcal(kcal)} kcal 🍽️`;
  }
  const simbolo = kcal > usuario.metaKcal ? '🟧' : '🟩';
  return `Calorías: ${barra(kcal, usuario.metaKcal, simbolo)} ${enKcal(kcal)} / ${enKcal(usuario.metaKcal)}`;
}

export function lineaAgua(ml, usuario) {
  return `Agua: ${barra(ml, usuario.metaAguaMl, '💧')} ${enLitros(ml)} / ${enLitros(usuario.metaAguaMl)} L`;
}

// ---------- Rachas ----------

// Cuenta cuántos días seguidos, hacia atrás desde "desde", aparecen en la lista de fechas.
function contarDiasSeguidos(fechas, desde) {
  const conjunto = new Set(fechas);
  let racha = 0;
  let dia = desde;
  while (conjunto.has(dia)) {
    racha++;
    dia = sumarDias(dia, -1);
  }
  return racha;
}

// Si hoy todavía no anotó nada, la racha sigue viva: se cuenta hasta ayer.
async function rachaComidas(usuario, fecha) {
  const dias = await diasConComidas(usuario.chatId);
  return contarDiasSeguidos(dias, fecha) || contarDiasSeguidos(dias, sumarDias(fecha, -1));
}

async function rachaAgua(usuario, fecha) {
  return contarDiasSeguidos(await diasConMetaDeAgua(usuario.chatId, usuario.metaAguaMl), fecha);
}

// Línea de racha para la primera comida del día: un logro si es un hito, o la racha si ya son 2+ días.
async function textoRachaComidas(usuario, fecha) {
  const racha = await rachaComidas(usuario, fecha);
  if (HITOS_RACHA.includes(racha)) return `🏅 ¡Logro! ${racha} días seguidos anotando tus comidas`;
  if (racha >= 2) return `🔥 Racha: ${racha} días seguidos anotando`;
  return null;
}

// ---------- Comida ----------

// Arma la respuesta después de anotar (o corregir) una comida. Ejemplo:
//
//   Anotado: almuerzo ~565 kcal ✅
//
//   Arroz amarillo con pollo, morrón y perejil
//
//   • Arroz amarillo: 250 g (243 kcal)
//   • Pollo en trozos: 90 g (209 kcal)
//
//   Proteínas 25 g · Carbohidratos 54 g · Grasas 25 g · Fibra 3 g
//
//   💡 ¡Buen plato! Si la próxima le sumás ensalada, te llena más 🥗
//
//   Calorías: 🟩🟩🟩🟩🟩🟩⬜⬜ 1.150 / 1.600
//
//   🔥 Racha: 6 días seguidos anotando
export async function mensajeComida({ usuario, encabezado, comida, fecha, descripcion = '', consejo = '', esPrimeraDelDia = false }) {
  const { items, totales } = comida;
  const bloques = [encabezado];

  if (descripcion) bloques.push(descripcion);
  bloques.push(items.map((item) => `• ${item.nombre}: ${Math.round(item.gramos)} g (${enKcal(item.nutrientes.kcal)} kcal)`).join('\n'));
  bloques.push(
    `Proteínas ${Math.round(totales.proteina_g)} g · Carbohidratos ${Math.round(totales.carbohidratos_g)} g · ` +
      `Grasas ${Math.round(totales.grasa_g)} g · Fibra ${Math.round(totales.fibra_g)} g`
  );
  if (consejo) bloques.push(`💡 ${consejo}`);
  bloques.push(lineaKcal(await kcalDelDia(usuario.chatId, fecha), usuario));

  // La racha se muestra solo con la primera comida del día, para no repetirla en cada mensaje.
  const racha = esPrimeraDelDia ? await textoRachaComidas(usuario, fecha) : null;
  if (racha) bloques.push(racha);

  return bloques.join('\n\n');
}

// ---------- Agua ----------

// Respuesta al sumar agua. Festeja cuando cruza la meta del día.
export async function mensajeAgua(usuario, mlAntes, mlAhora, fecha) {
  const lineas = [lineaAgua(mlAhora, usuario)];

  const cumplioRecien = mlAntes < usuario.metaAguaMl && mlAhora >= usuario.metaAguaMl;
  if (cumplioRecien) {
    lineas.push('', '🎉 ¡Cumpliste la meta de agua de hoy!');
    const racha = await rachaAgua(usuario, fecha);
    if (HITOS_RACHA.includes(racha)) lineas.push(`🏅 ¡Logro! ${racha} días seguidos cumpliendo el agua`);
    else if (racha >= 2) lineas.push(`💧 Racha de agua: ${racha} días seguidos`);
  }
  return lineas.join('\n');
}

// ---------- Peso ----------

// Qué parte del camino entre el peso inicial y la meta ya recorrió.
// Sirve tanto si la meta es bajar como si es subir de peso.
function textoMeta(kg, pesoInicial, objetivo) {
  const quiereBajar = pesoInicial >= objetivo;
  const llego = quiereBajar ? kg <= objetivo : kg >= objetivo;
  if (llego) {
    return `¡Llegaste a tu meta de ${enKg(objetivo)} kg! 🎉`;
  }
  const avance = Math.round(((pesoInicial - kg) / (pesoInicial - objetivo)) * 100);
  const falta = unDecimal(Math.abs(kg - objetivo));
  // Si se alejó de la meta, mostramos 0% en vez de un porcentaje negativo.
  return `Llevás el ${Math.max(0, avance)}% del camino a tu meta de ${enKg(objetivo)} kg (te faltan ${enKg(falta)} kg)`;
}

// El peso sube y baja hasta 1-2 kg de un día al otro (agua, sal), así que el
// promedio semanal muestra mejor si va bien. Devuelve null si faltan datos.
async function textoTendencia(usuario, fecha) {
  const estaSemana = await promedioPeso(usuario.chatId, sumarDias(fecha, -6), fecha);
  const semanaAnterior = await promedioPeso(usuario.chatId, sumarDias(fecha, -13), sumarDias(fecha, -7));
  if (estaSemana === null || semanaAnterior === null) return null;

  const cambio = unDecimal(estaSemana - semanaAnterior);
  const flecha = cambio < 0 ? '📉' : cambio > 0 ? '📈' : '➡️';
  const signo = cambio > 0 ? '+' : '';
  return `Promedio de esta semana: ${enKg(estaSemana)} kg (${signo}${enKg(cambio)} kg vs la semana anterior) ${flecha}`;
}

// Hitos de peso perdido: el primer kilo, cada 5 kg, y el 5% y 10% del peso inicial.
// Solo festeja al cruzar un hito por primera vez (comparando con el mínimo anterior),
// así no se repite cuando el peso sube y baja alrededor del mismo número.
function logrosDePeso(usuario, kg, pesoInicial, minimoAnterior) {
  const quiereSubir = usuario.pesoObjetivo && usuario.pesoObjetivo > pesoInicial;
  if (pesoInicial === null || minimoAnterior === null || quiereSubir) return [];

  const bajadoAntes = unDecimal(pesoInicial - minimoAnterior);
  const bajadoAhora = unDecimal(pesoInicial - kg);
  const cruzo = (kilos) => bajadoAhora >= kilos && bajadoAntes < kilos;

  const logros = [];
  if (cruzo(1)) logros.push('🏅 ¡Bajaste tu primer kilo! Así se empieza 💪');
  for (let kilos = 5; kilos <= bajadoAhora; kilos += 5) {
    if (cruzo(kilos)) logros.push(`🏅 ¡Ya bajaste ${kilos} kg! 👏`);
  }
  if (cruzo(unDecimal(pesoInicial * 0.05))) {
    logros.push('🏅 ¡Bajaste el 5% de tu peso inicial! Esto ya trae beneficios reales para tu salud 💚');
  }
  if (cruzo(unDecimal(pesoInicial * 0.1))) logros.push('🏅 ¡Bajaste el 10% de tu peso inicial! Enorme logro 🎉');
  return logros;
}

// Arma la respuesta después de anotar un peso. Ejemplo:
//
//   Anotado: 102,1 kg ✅
//
//   Bajaste 3,1 kg desde el inicio (-2,9%)
//   Llevás el 15% del camino a tu meta de 85 kg (te faltan 17,1 kg)
//   Promedio de esta semana: 102,4 kg (-0,6 kg vs la semana anterior) 📉
//   Desde la última vez: -0,4 kg
//
//   🏅 ¡Ya bajaste 5 kg! 👏
export async function mensajePeso({ usuario, kg, fecha, pesoInicial, pesoAnterior, minimoAnterior }) {
  const lineas = [`Anotado: ${enKg(kg)} kg ✅`, ''];

  if (pesoInicial === null) {
    lineas.push('Es tu primer registro: desde acá medimos el avance 💪');
  } else {
    const cambio = unDecimal(kg - pesoInicial);
    const porcentaje = unDecimal((cambio / pesoInicial) * 100);
    if (cambio < 0) lineas.push(`Bajaste ${enKg(-cambio)} kg desde el inicio (${enKg(porcentaje)}%)`);
    if (cambio > 0) lineas.push(`Subiste ${enKg(cambio)} kg desde el inicio (+${enKg(porcentaje)}%)`);
    if (cambio === 0) lineas.push('Estás igual que al inicio');
  }

  if (usuario.pesoObjetivo) {
    // En el primer registro, el peso de hoy es también el punto de partida.
    lineas.push(textoMeta(kg, pesoInicial ?? kg, usuario.pesoObjetivo));
  }

  const tendencia = await textoTendencia(usuario, fecha);
  if (tendencia) lineas.push(tendencia);

  if (pesoAnterior !== null) {
    const cambio = unDecimal(kg - pesoAnterior);
    if (cambio === 0) lineas.push('Desde la última vez: sin cambios');
    if (cambio < 0) lineas.push(`Desde la última vez: ${enKg(cambio)} kg`);
    // Una suba de un día para el otro casi siempre es agua: lo aclaramos para que no se desanime.
    if (cambio > 0) lineas.push(`Desde la última vez: +${enKg(cambio)} kg (es normal que varíe día a día; lo que importa es el promedio)`);
  }

  const logros = logrosDePeso(usuario, kg, pesoInicial, minimoAnterior);
  if (logros.length > 0) lineas.push('', ...logros);

  return lineas.join('\n');
}

// ---------- Contexto para Claude ----------

// Resumen del día en texto para que Claude responda preguntas y dé consejos con datos reales.
export async function contextoDelDia(usuario, fechaHora) {
  const fecha = fechaHora.slice(0, 10);
  const comidas = await comidasDelDia(usuario.chatId, fecha);
  const lineas = [`Persona: ${usuario.nombre ?? 'sin nombre'}.`, `Fecha y hora: ${fechaHora}.`];

  const metaKcal = usuario.metaKcal ? ` (meta: ${enKcal(usuario.metaKcal)} kcal)` : '';
  lineas.push(`Calorías de hoy: ${enKcal(await kcalDelDia(usuario.chatId, fecha))} kcal${metaKcal}.`);
  lineas.push(`Agua de hoy: ${enLitros(await aguaDelDia(usuario.chatId, fecha))} L (meta: ${enLitros(usuario.metaAguaMl)} L).`);

  if (comidas.length > 0) {
    const detalle = comidas.map((comida) => `${comida.tipo_comida} (${comida.items.map((item) => item.nombre).join(', ')})`);
    lineas.push(`Comidas de hoy: ${detalle.join('; ')}.`);
  } else {
    lineas.push('Todavía no anotó comidas hoy.');
  }

  const peso = await ultimoPeso(usuario.chatId);
  if (peso !== null) {
    const meta = usuario.pesoObjetivo ? ` (meta: ${enKg(usuario.pesoObjetivo)} kg)` : '';
    lineas.push(`Último peso: ${enKg(peso)} kg${meta}.`);
  }
  return lineas.join('\n');
}

// ---------- Resúmenes ----------

// Resumen del día: lo usan el botón "¿Cómo voy?" y el mensaje de cada noche.
export async function resumenDelDia(usuario, fecha) {
  const { chatId } = usuario;
  const cantidad = (await comidasDelDia(chatId, fecha)).length;
  const lineas = [];

  if (cantidad === 0) {
    lineas.push('Hoy todavía no anotaste comidas.');
  } else {
    lineas.push(`Comidas anotadas: ${cantidad}`, lineaKcal(await kcalDelDia(chatId, fecha), usuario));
  }
  lineas.push(lineaAgua(await aguaDelDia(chatId, fecha), usuario));

  const peso = await ultimoPesoDelDia(chatId, fecha);
  if (peso) lineas.push(`Peso: ${enKg(peso.kg)} kg`);

  const racha = await rachaComidas(usuario, fecha);
  if (racha >= 2) lineas.push(`🔥 Racha: ${racha} días seguidos anotando`);

  return lineas.join('\n');
}

// Resumen de los últimos 7 días (terminando en "fecha"). Se escribe en forma neutra
// porque también les llega a los demás. Devuelve null si no anotó nada en la semana.
export async function resumenSemanal(usuario, fecha) {
  const { chatId } = usuario;
  const desde = sumarDias(fecha, -6);
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(desde, i));

  // Juntamos los datos de cada día de la semana una sola vez.
  const semana = [];
  for (const dia of dias) {
    semana.push({
      dia,
      comidas: (await comidasDelDia(chatId, dia)).length,
      kcal: await kcalDelDia(chatId, dia),
      agua: await aguaDelDia(chatId, dia),
    });
  }

  const diasAnotados = semana.filter((d) => d.comidas > 0);
  const diasConAgua = semana.filter((d) => d.agua >= usuario.metaAguaMl);
  const huboAgua = semana.some((d) => d.agua > 0);
  const huboPeso = (await promedioPeso(chatId, desde, fecha)) !== null;
  if (diasAnotados.length === 0 && !huboAgua && !huboPeso) return null;

  const lineas = [`📊 Resumen de la semana (${diaYMes(desde)} al ${diaYMes(fecha)})`, ''];
  lineas.push(`Días con comidas anotadas: ${diasAnotados.length} de 7`);

  // El promedio se calcula solo con los días anotados: un día sin anotar no es un día sin comer.
  if (diasAnotados.length > 0) {
    const totalKcal = diasAnotados.reduce((suma, d) => suma + d.kcal, 0);
    const meta = usuario.metaKcal ? ` (meta: ${enKcal(usuario.metaKcal)})` : '';
    lineas.push(`Promedio de calorías: ${enKcal(totalKcal / diasAnotados.length)} kcal por día${meta}`);
  }
  lineas.push(`Días con la meta de agua cumplida: ${diasConAgua.length} de 7`);

  const tendencia = await textoTendencia(usuario, fecha);
  if (tendencia) lineas.push(tendencia);

  const inicial = await primerPeso(chatId);
  const actual = await ultimoPeso(chatId);
  if (inicial !== null && actual !== null && inicial !== actual) {
    const cambio = unDecimal(actual - inicial);
    lineas.push(`Desde el inicio: ${cambio > 0 ? '+' : ''}${enKg(cambio)} kg`);
  }

  const racha = await rachaComidas(usuario, fecha);
  if (racha >= 2) lineas.push(`🔥 Racha actual: ${racha} días seguidos anotando`);

  lineas.push('', diasAnotados.length >= 5 ? '¡Gran semana! Seguí así 💪' : 'Cada día que anotás suma. ¡Vamos por una gran semana! 💪');
  return lineas.join('\n');
}
