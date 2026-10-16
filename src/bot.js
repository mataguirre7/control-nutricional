// Handlers del bot de Telegram: fotos, peso escrito y botón de agua.
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard } from 'grammy';
import { config, CARPETA_FOTOS, RANGOS_COMIDAS } from './config.js';
import {
  ahoraLocal,
  hoyLocal,
  guardarAgua,
  guardarPeso,
  guardarComida,
  aguaDelDia,
  kcalDelDia,
  primerPeso,
  ultimoPeso,
} from './db.js';
import { analizarFoto } from './vision.js';
import { calcularComida } from './nutrition.js';

// Botón que suma un vaso de agua. Se usa acá y en los recordatorios.
export const tecladoAgua = new InlineKeyboard().text('+1 vaso 💧', 'agua');

const AYUDA = 'Mandame una foto de lo que comés o de la balanza, o escribí tu peso (ej: 72.5). Para el agua usá /agua 💧';

// fechaHora: "2026-10-16 13:05:00" → "almuerzo"
function tipoComidaSegunHora(fechaHora) {
  const hora = Number(fechaHora.slice(11, 13));
  const rango = RANGOS_COMIDAS.find((r) => hora >= r.desde && hora < r.hasta);
  return rango ? rango.tipo : 'cena';
}

// 1250 → "1,25"
function enLitros(ml) {
  return (ml / 1000).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// Arma la respuesta después de anotar una comida. Va en texto plano, sin formato,
// para que se lea simple en cualquier celular. Ejemplo:
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
//   Llevás 1.320 kcal hoy 🍽️
function mensajeComida(tipoComida, descripcion, comida, kcalHoy) {
  const { items, totales } = comida;
  const lineas = [`Anotado: ${tipoComida} ~${Math.round(totales.kcal)} kcal ✅`, ''];

  if (descripcion) {
    lineas.push(descripcion, '');
  }
  for (const item of items) {
    lineas.push(`• ${item.nombre}: ${Math.round(item.gramos)} g (${Math.round(item.nutrientes.kcal)} kcal)`);
  }
  lineas.push(
    '',
    `Proteínas ${Math.round(totales.proteina_g)} g · Carbohidratos ${Math.round(totales.carbohidratos_g)} g · ` +
      `Grasas ${Math.round(totales.grasa_g)} g · Fibra ${Math.round(totales.fibra_g)} g`,
    '',
    `Llevás ${Math.round(kcalHoy).toLocaleString('es-AR')} kcal hoy 🍽️`
  );
  return lineas.join('\n');
}

function textoAguaDeHoy() {
  return `Llevás ${enLitros(aguaDelDia(hoyLocal()))} L de agua hoy 💧`;
}

// Telegram manda la misma foto en varios tamaños; la última es la más grande.
async function descargarFoto(ctx) {
  const foto = ctx.message.photo.at(-1);
  const archivo = await ctx.api.getFile(foto.file_id);
  const url = `https://api.telegram.org/file/bot${config.telegramToken}/${archivo.file_path}`;

  const respuesta = await fetch(url);
  if (!respuesta.ok) {
    throw new Error(`Telegram respondió ${respuesta.status} al bajar la foto`);
  }
  return Buffer.from(await respuesta.arrayBuffer());
}

// Guarda la foto como data/fotos/2026-10-16_130500_<id del mensaje>.jpg y devuelve la ruta.
// El id del mensaje evita pisar fotos mandadas en el mismo segundo.
function guardarFotoEnDisco(imagen, fechaHora, idMensaje) {
  const nombre = `${fechaHora.replace(' ', '_').replaceAll(':', '')}_${idMensaje}.jpg`;
  const ruta = path.posix.join(CARPETA_FOTOS, nombre);
  fs.writeFileSync(ruta, imagen);
  return ruta;
}

// 102.14 → "102,1" (formato argentino, máximo un decimal)
function enKg(valor) {
  return valor.toLocaleString('es-AR', { maximumFractionDigits: 1 });
}

// Redondea a un decimal para no mostrar restos como -0.4000000001.
function unDecimal(valor) {
  return Math.round(valor * 10) / 10;
}

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

// Arma la respuesta después de anotar un peso. Ejemplo:
//
//   Anotado: 102,1 kg ✅
//
//   Bajaste 3,1 kg desde el inicio (-2,9%)
//   Llevás el 15% del camino a tu meta de 85 kg (te faltan 17,1 kg)
//   Desde la última vez: -0,4 kg
function mensajePeso(kg, pesoInicial, pesoAnterior) {
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

  if (config.pesoObjetivo) {
    // En el primer registro, el peso de hoy es también el punto de partida.
    lineas.push(textoMeta(kg, pesoInicial ?? kg, config.pesoObjetivo));
  }

  if (pesoAnterior !== null) {
    const cambio = unDecimal(kg - pesoAnterior);
    const texto = cambio === 0 ? 'sin cambios' : `${cambio > 0 ? '+' : ''}${enKg(cambio)} kg`;
    lineas.push(`Desde la última vez: ${texto}`);
  }
  return lineas.join('\n');
}

async function registrarPeso(ctx, kg) {
  // Un número fuera de este rango seguramente es un error de tipeo o de lectura.
  if (kg < 20 || kg > 300) {
    await ctx.reply(`${kg} kg no me parece un peso correcto 🤔 Probá de nuevo (ej: 72.5).`);
    return;
  }
  // Se leen antes de guardar, para comparar contra los pesos anteriores y no contra este.
  const pesoInicial = primerPeso();
  const pesoAnterior = ultimoPeso();
  guardarPeso(kg);
  await ctx.reply(mensajePeso(kg, pesoInicial, pesoAnterior));
}

async function procesarFoto(ctx) {
  await ctx.reply('Mirando la foto… 👀');

  const fechaHora = ahoraLocal();
  const imagen = await descargarFoto(ctx);
  const fotoPath = guardarFotoEnDisco(imagen, fechaHora, ctx.message.message_id);
  // Las fotos comprimidas de Telegram siempre llegan como JPEG.
  const analisis = await analizarFoto(imagen, 'image/jpeg');

  if (analisis.tipo === 'comida' && analisis.items.length > 0) {
    const comida = await calcularComida(analisis.items);
    const tipoComida = tipoComidaSegunHora(fechaHora);
    guardarComida({ fechaHora, tipoComida, fotoPath, ...comida });
    // Se calcula después de guardar, así el acumulado ya incluye esta comida.
    // Usamos el día de la foto: si llegó 23:59 y terminamos 00:00, sigue contando para ese día.
    const kcalHoy = kcalDelDia(fechaHora.slice(0, 10));
    await ctx.reply(mensajeComida(tipoComida, analisis.descripcion, comida, kcalHoy));
  } else if (analisis.tipo === 'balanza' && analisis.kg) {
    await registrarPeso(ctx, analisis.kg);
  } else if (analisis.tipo === 'balanza') {
    await ctx.reply('No pude leer el número de la balanza 🤔 Probá con otra foto o escribilo (ej: 72.5).');
  } else {
    await ctx.reply(`No entendí la foto 🤔 ${AYUDA}`);
  }
}

export function crearBot() {
  const bot = new Bot(config.telegramToken);

  // Solo atendemos al chat configurado; cualquier otro se ignora.
  // El log sirve para averiguar el chat_id la primera vez.
  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id) !== config.telegramChatId) {
      console.log(`Mensaje ignorado de chat_id ${ctx.chat?.id}`);
      return;
    }
    await next();
  });

  bot.command('start', (ctx) => ctx.reply(`¡Hola! ${AYUDA}`));

  bot.command('agua', (ctx) => ctx.reply(`${textoAguaDeHoy()}\nTocá el botón cada vez que tomes un vaso.`, { reply_markup: tecladoAgua }));

  bot.callbackQuery('agua', async (ctx) => {
    guardarAgua(config.vasoMl);
    await ctx.answerCallbackQuery({ text: '+1 vaso 💧' });
    await ctx.reply(textoAguaDeHoy());
  });

  bot.on('message:photo', async (ctx) => {
    try {
      await procesarFoto(ctx);
    } catch (error) {
      console.error('Error procesando la foto:', error);
      await ctx.reply('No pude procesar la foto, probá de nuevo');
    }
  });

  bot.on('message:text', async (ctx) => {
    // Acepta "72.5", "72,5" o "72.5 kg".
    const coincidencia = ctx.message.text.trim().match(/^(\d{2,3}(?:[.,]\d{1,2})?)\s*(kg)?$/i);
    if (coincidencia) {
      await registrarPeso(ctx, Number(coincidencia[1].replace(',', '.')));
    } else {
      await ctx.reply(AYUDA);
    }
  });

  // Último recurso: cualquier error no atrapado se loguea y el bot sigue andando.
  bot.catch((error) => {
    console.error('Error en el bot:', error.error ?? error);
  });

  return bot;
}
