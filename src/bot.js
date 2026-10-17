// Handlers del bot de Telegram: fotos, textos, agua, peso, metas y botones.
// Cada persona habla con el bot desde su propio chat, y ctx.usuario dice de quién son los datos.
//
// Está pensado para que nadie necesite comandos: hay botones fijos abajo del chat y Claude
// entiende frases como "tomé 2 vasos" o "quiero llegar a 85 kilos". Los comandos (/agua,
// /meta_peso 85, etc.) siguen funcionando como atajo para quien los conozca.
import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { config, CARPETA_FOTOS, RANGOS_COMIDAS } from './config.js';
import {
  ahoraLocal,
  hoyLocal,
  registrarUsuario,
  obtenerUsuario,
  guardarMeta,
  guardarAgua,
  guardarPeso,
  guardarComida,
  comidaPorId,
  actualizarComida,
  borrarComida,
  comidasDelDia,
  kcalDelDia,
  aguaDelDia,
  primerPeso,
  ultimoPeso,
  pesoMinimo,
} from './db.js';
import { analizarFoto, analizarTexto } from './vision.js';
import { calcularComida, escalarComida } from './nutrition.js';
import {
  mensajeComida,
  mensajeAgua,
  mensajePeso,
  lineaKcal,
  contextoDelDia,
  resumenDelDia,
  textoMetas,
  enKg,
  enKcal,
  enLitros,
} from './progreso.js';

// Textos de los botones fijos. Al tocarlos, Telegram manda ese mismo texto como mensaje.
const BOTONES = {
  vaso: '💧 Tomé un vaso',
  comoVoy: '📊 ¿Cómo voy?',
  metas: '🎯 Mis metas',
  ayuda: '❓ Ayuda',
};

// Botones grandes que quedan siempre abajo del chat, en lugar del teclado.
export const tecladoPrincipal = new Keyboard()
  .text(BOTONES.vaso)
  .text(BOTONES.comoVoy)
  .row()
  .text(BOTONES.metas)
  .text(BOTONES.ayuda)
  .resized()
  .persistent();

// Botón debajo de los recordatorios de agua.
export const tecladoAgua = new InlineKeyboard().text('+1 vaso 💧', 'agua');

// Botones debajo de cada comida anotada, para corregir la porción o borrarla.
function tecladoCorreccion(idComida) {
  return new InlineKeyboard()
    .text('➖ Era menos', `menos:${idComida}`)
    .text('➕ Era más', `mas:${idComida}`)
    .text('🗑️ Borrar', `borrar:${idComida}`);
}

const AYUDA = [
  'Podés mandarme:',
  '📸 Una foto de lo que comés o de la balanza',
  '✍️ Lo que comiste, como si me lo contaras (ej: "comí 2 empanadas de carne")',
  '⚖️ Tu peso (ej: 72.5)',
  '💧 El agua que tomás (tocá "💧 Tomé un vaso" o escribime "tomé 2 vasos")',
  '🎯 Tus metas (ej: "quiero llegar a 85 kilos")',
  '❓ Cualquier pregunta (ej: "¿qué puedo cenar?")',
  '',
  'Los botones de abajo te ayudan con lo más común 👇',
].join('\n');

// Reglas de cada meta: en qué columna se guarda, qué valores son razonables y cómo se muestra.
const METAS = {
  peso: { columna: 'peso_objetivo', etiqueta: 'peso', minimo: 30, maximo: 300, ejemplo: 'quiero llegar a 85 kilos', mostrar: (v) => `${enKg(v)} kg` },
  kcal: { columna: 'meta_kcal', etiqueta: 'calorías', minimo: 800, maximo: 5000, ejemplo: 'quiero comer 1600 calorías por día', mostrar: (v) => `${enKcal(v)} kcal por día` },
  agua: { columna: 'meta_agua_ml', etiqueta: 'agua', minimo: 500, maximo: 6000, ejemplo: 'quiero tomar 2 litros de agua por día', mostrar: (v) => `${enLitros(v)} L por día` },
};

// fechaHora: "2026-10-16 13:05:00" → "almuerzo"
function tipoComidaSegunHora(fechaHora) {
  const hora = Number(fechaHora.slice(11, 13));
  const rango = RANGOS_COMIDAS.find((r) => hora >= r.desde && hora < r.hasta);
  return rango ? rango.tipo : 'cena';
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

// Guarda la foto como data/fotos/<chat_id>_2026-10-16_130500_<id del mensaje>.jpg y devuelve la ruta.
// El chat_id separa las fotos de cada persona; el id del mensaje evita pisar fotos del mismo segundo.
function guardarFotoEnDisco(imagen, chatId, fechaHora, idMensaje) {
  const nombre = `${chatId}_${fechaHora.replace(' ', '_').replaceAll(':', '')}_${idMensaje}.jpg`;
  const ruta = path.posix.join(CARPETA_FOTOS, nombre);
  fs.writeFileSync(ruta, imagen);
  return ruta;
}

// "/meta_peso 85" → 85, "/meta_peso 72,5" → 72.5, "/meta_peso" → null
function numeroDelComando(ctx) {
  const texto = ctx.match.trim().replace(',', '.');
  const valor = Number(texto);
  return texto === '' || Number.isNaN(valor) ? null : valor;
}

// Sirve tanto para los comandos (/meta_peso 85) como para frases ("quiero llegar a 85 kilos").
// valor 0 saca la meta.
async function cambiarMeta(ctx, nombreMeta, valor) {
  const meta = METAS[nombreMeta];

  if (valor === 0) {
    guardarMeta(ctx.usuario.chatId, meta.columna, null);
    await ctx.reply(`Listo, saqué tu meta de ${meta.etiqueta} ✅`, { reply_markup: tecladoPrincipal });
    return;
  }
  // Para el agua aceptamos litros ("2") o mililitros ("2000").
  if (nombreMeta === 'agua' && valor !== null && valor < 20) {
    valor = valor * 1000;
  }
  if (valor === null || valor < meta.minimo || valor > meta.maximo) {
    await ctx.reply(`No me quedó claro el número 🤔 Probá escribiendo, por ejemplo: "${meta.ejemplo}"`);
    return;
  }

  guardarMeta(ctx.usuario.chatId, meta.columna, valor);
  await ctx.reply(`Listo, tu meta de ${meta.etiqueta} es ${meta.mostrar(valor)} ✅`, { reply_markup: tecladoPrincipal });
}

// Suma agua y responde con la barra (y el festejo si llegó a la meta).
// opciones: lo que se agrega a la respuesta (por ejemplo, el botón "+1 vaso").
async function sumarAgua(ctx, ml, opciones = {}) {
  // Más de 3 L en un solo mensaje seguramente es un error de interpretación.
  if (!ml || ml <= 0 || ml > 3000) {
    await ctx.reply('No me quedó clara la cantidad de agua 🤔 Probá con "tomé un vaso" o tocá "💧 Tomé un vaso".');
    return;
  }
  const { usuario } = ctx;
  const hoy = hoyLocal();
  const mlAntes = aguaDelDia(usuario.chatId, hoy);
  guardarAgua(usuario.chatId, ml);
  await ctx.reply(mensajeAgua(usuario, mlAntes, mlAntes + ml, hoy), opciones);
}

async function registrarPeso(ctx, kg) {
  const { usuario } = ctx;
  // Un número fuera de este rango seguramente es un error de tipeo o de lectura.
  if (kg < 20 || kg > 300) {
    await ctx.reply(`${kg} kg no me parece un peso correcto 🤔 Probá de nuevo (ej: 72.5).`);
    return;
  }
  // Se leen antes de guardar, para comparar contra los pesos anteriores y no contra este.
  const pesoInicial = primerPeso(usuario.chatId);
  const pesoAnterior = ultimoPeso(usuario.chatId);
  const minimoAnterior = pesoMinimo(usuario.chatId);
  guardarPeso(usuario.chatId, kg);
  const mensaje = mensajePeso({ usuario, kg, fecha: hoyLocal(), pesoInicial, pesoAnterior, minimoAnterior });
  await ctx.reply(mensaje, { reply_markup: tecladoPrincipal });
}

async function registrarComida(ctx, analisis, fechaHora, fotoPath) {
  const { usuario } = ctx;
  const comida = await calcularComida(analisis.items);
  const tipoComida = tipoComidaSegunHora(fechaHora);
  const idComida = guardarComida({ chatId: usuario.chatId, fechaHora, tipoComida, fotoPath, ...comida });

  // Usamos el día del mensaje: si llegó 23:59 y terminamos 00:00, sigue contando para ese día.
  const fecha = fechaHora.slice(0, 10);
  const mensaje = mensajeComida({
    usuario,
    encabezado: `Anotado: ${tipoComida} ~${Math.round(comida.totales.kcal)} kcal ✅`,
    comida,
    fecha,
    descripcion: analisis.descripcion,
    consejo: analisis.consejo,
    esPrimeraDelDia: comidasDelDia(usuario.chatId, fecha).length === 1,
  });
  await ctx.reply(mensaje, { reply_markup: tecladoCorreccion(idComida) });
}

// Decide qué hacer según lo que entendió Claude. Sirve igual para fotos y para textos.
async function responderAnalisis(ctx, analisis, fechaHora, fotoPath = null) {
  if (analisis.tipo === 'comida' && analisis.items.length > 0) {
    await registrarComida(ctx, analisis, fechaHora, fotoPath);
  } else if (analisis.tipo === 'balanza' && analisis.kg) {
    await registrarPeso(ctx, analisis.kg);
  } else if (analisis.tipo === 'balanza') {
    await ctx.reply('No pude leer el número de la balanza 🤔 Probá con otra foto o escribilo (ej: 72.5).');
  } else if (analisis.tipo === 'agua') {
    // Si no dijo cuánto, es un vaso.
    await sumarAgua(ctx, analisis.agua_ml ?? config.vasoMl);
  } else if (analisis.tipo === 'meta' && analisis.meta !== 'ninguna') {
    await cambiarMeta(ctx, analisis.meta, analisis.meta_valor);
  } else {
    await ctx.reply(analisis.respuesta || `No te entendí 🤔\n\n${AYUDA}`, { reply_markup: tecladoPrincipal });
  }
}

// Qué hace cada botón fijo. Se revisa antes de llamar a Claude, así tocar un botón no cuesta nada.
const ACCIONES_DE_BOTONES = {
  [BOTONES.vaso]: (ctx) => sumarAgua(ctx, config.vasoMl),
  [BOTONES.comoVoy]: (ctx) => ctx.reply(`📊 Tu día hasta ahora\n\n${resumenDelDia(ctx.usuario, hoyLocal())}`, { reply_markup: tecladoPrincipal }),
  [BOTONES.metas]: (ctx) => ctx.reply(textoMetas(ctx.usuario), { reply_markup: tecladoPrincipal }),
  [BOTONES.ayuda]: (ctx) => ctx.reply(AYUDA, { reply_markup: tecladoPrincipal }),
};

async function procesarFoto(ctx) {
  await ctx.reply('Mirando la foto… 👀');

  const fechaHora = ahoraLocal();
  const imagen = await descargarFoto(ctx);
  const fotoPath = guardarFotoEnDisco(imagen, ctx.usuario.chatId, fechaHora, ctx.message.message_id);
  // Las fotos comprimidas de Telegram siempre llegan como JPEG.
  const contexto = contextoDelDia(ctx.usuario, fechaHora);
  const analisis = await analizarFoto(imagen, 'image/jpeg', contexto, ctx.message.caption);
  await responderAnalisis(ctx, analisis, fechaHora, fotoPath);
}

async function procesarTexto(ctx) {
  const texto = ctx.message.text.trim();

  const accionDeBoton = ACCIONES_DE_BOTONES[texto];
  if (accionDeBoton) {
    await accionDeBoton(ctx);
    return;
  }

  // Un número solo ("72.5", "72,5" o "72.5 kg") es un peso: no hace falta preguntarle a Claude.
  const peso = texto.match(/^(\d{2,3}(?:[.,]\d{1,2})?)\s*(kg)?$/i);
  if (peso) {
    await registrarPeso(ctx, Number(peso[1].replace(',', '.')));
    return;
  }

  await ctx.replyWithChatAction('typing');
  const fechaHora = ahoraLocal();
  const analisis = await analizarTexto(texto, contextoDelDia(ctx.usuario, fechaHora));
  await responderAnalisis(ctx, analisis, fechaHora);
}

// Botones "Era menos" / "Era más": escala la porción y manda la comida corregida.
async function corregirPorcion(ctx) {
  const [, accion, id] = ctx.match;
  const comida = comidaPorId(ctx.usuario.chatId, Number(id));
  if (!comida) {
    await ctx.answerCallbackQuery({ text: 'Esa comida ya no está 🤔' });
    return;
  }

  // 0.8 y 1.25 son inversos (0.8 × 1.25 = 1): tocar "menos" y después "más" vuelve al valor original.
  const corregida = escalarComida(comida, accion === 'mas' ? 1.25 : 0.8);
  actualizarComida(comida.id, corregida.items, corregida.totales);
  await ctx.answerCallbackQuery({ text: 'Corregido ✅' });

  const mensaje = mensajeComida({
    usuario: ctx.usuario,
    encabezado: `Corregido: ${comida.tipo_comida} ~${Math.round(corregida.totales.kcal)} kcal ✅`,
    comida: corregida,
    fecha: comida.fecha_hora.slice(0, 10),
  });
  await ctx.reply(mensaje, { reply_markup: tecladoCorreccion(comida.id) });
  // Sacamos los botones del mensaje viejo para que siempre se use el último.
  // Si Telegram no deja editarlo (mensaje muy viejo), no pasa nada.
  await ctx.editMessageReplyMarkup().catch(() => {});
}

export function crearBot() {
  const bot = new Bot(config.telegramToken);

  // Solo atendemos a los chats configurados; cualquier otro se ignora.
  // El log sirve para averiguar el chat_id de alguien nuevo.
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id);
    if (!config.telegramChatIds.includes(chatId)) {
      console.log(`Mensaje ignorado de chat_id ${chatId}`);
      return;
    }
    registrarUsuario(chatId, ctx.from?.first_name ?? null);
    // Dejamos a la persona (con sus metas) en el contexto, para que cada handler sepa de quién son los datos.
    ctx.usuario = obtenerUsuario(chatId);
    await next();
  });

  // /start es lo primero que manda Telegram cuando alguien toca "Iniciar": ahí aparecen los botones fijos.
  bot.command('start', (ctx) => {
    const saludo = `¡Hola${ctx.usuario.nombre ? `, ${ctx.usuario.nombre}` : ''}! 👋`;
    return ctx.reply(`${saludo}\n\n${AYUDA}`, { reply_markup: tecladoPrincipal });
  });

  // Atajos para quien conoce los comandos. Hacen lo mismo que los botones y las frases.
  bot.command('hoy', ACCIONES_DE_BOTONES[BOTONES.comoVoy]);
  bot.command('metas', ACCIONES_DE_BOTONES[BOTONES.metas]);
  bot.command('agua', (ctx) => sumarAgua(ctx, config.vasoMl));
  bot.command('meta_peso', (ctx) => cambiarMeta(ctx, 'peso', numeroDelComando(ctx)));
  bot.command('meta_kcal', (ctx) => cambiarMeta(ctx, 'kcal', numeroDelComando(ctx)));
  bot.command('meta_agua', (ctx) => cambiarMeta(ctx, 'agua', numeroDelComando(ctx)));

  bot.callbackQuery('agua', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '+1 vaso 💧' });
    await sumarAgua(ctx, config.vasoMl, { reply_markup: tecladoAgua });
  });

  bot.callbackQuery(/^(menos|mas):(\d+)$/, corregirPorcion);

  // Borrar pide confirmación, para que un toque sin querer no se lleve una comida.
  bot.callbackQuery(/^borrar:(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery();
    const confirmar = new InlineKeyboard().text('Sí, borrar 🗑️', `borrar-si:${id}`).text('No, dejarla', `borrar-no:${id}`);
    await ctx.editMessageReplyMarkup({ reply_markup: confirmar });
  });

  bot.callbackQuery(/^borrar-no:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: tecladoCorreccion(ctx.match[1]) });
  });

  bot.callbackQuery(/^borrar-si:(\d+)$/, async (ctx) => {
    const comida = comidaPorId(ctx.usuario.chatId, Number(ctx.match[1]));
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!comida) {
      await ctx.answerCallbackQuery({ text: 'Esa comida ya no está 🤔' });
      return;
    }

    borrarComida(comida.id);
    await ctx.answerCallbackQuery({ text: 'Borrada 🗑️' });
    const kcal = kcalDelDia(ctx.usuario.chatId, comida.fecha_hora.slice(0, 10));
    await ctx.reply(`Listo, borré esa comida 🗑️\n\n${lineaKcal(kcal, ctx.usuario)}`, { reply_markup: tecladoPrincipal });
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
    try {
      await procesarTexto(ctx);
    } catch (error) {
      console.error('Error procesando el texto:', error);
      await ctx.reply('No pude procesar tu mensaje, probá de nuevo');
    }
  });

  // Último recurso: cualquier error no atrapado se loguea y el bot sigue andando.
  bot.catch((error) => {
    console.error('Error en el bot:', error.error ?? error);
  });

  return bot;
}
