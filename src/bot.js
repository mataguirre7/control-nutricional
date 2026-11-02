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
  guardarDatoDeUsuario,
  guardarEjercicio,
  borrarEjercicio,
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
  mensajeEjercicio,
  textoTmb,
  textoProgresoGrasa,
  actualizarSiCorresponde,
  recalcularHistorial,
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
  ejercicio: '🏃 Hice ejercicio',
  tmb: '🔥 Mi TMB',
  metas: '🎯 Mis metas',
  ayuda: '❓ Ayuda',
};

// Botones grandes que quedan siempre abajo del chat, en lugar del teclado.
export const tecladoPrincipal = new Keyboard()
  .text(BOTONES.vaso)
  .text(BOTONES.comoVoy)
  .row()
  .text(BOTONES.ejercicio)
  .text(BOTONES.tmb)
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
  '🏃 El ejercicio que hiciste (ej: "caminé 40 minutos")',
  '🎯 Tus metas (ej: "quiero llegar a 85 kilos")',
  '❓ Cualquier pregunta (ej: "¿qué puedo cenar?")',
  '',
  'También podés contarme varias cosas en un solo mensaje 😉',
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

// Guarda una meta y devuelve el texto para confirmarla (o para avisar que el número no sirve).
// valor 0 saca la meta.
async function guardarUnaMeta(chatId, nombreMeta, valor) {
  const meta = METAS[nombreMeta];

  if (valor === 0) {
    await guardarDatoDeUsuario(chatId, meta.columna, null);
    return `Listo, saqué tu meta de ${meta.etiqueta} ✅`;
  }
  // Para el agua aceptamos litros ("2") o mililitros ("2000").
  if (nombreMeta === 'agua' && valor !== null && valor < 20) {
    valor = valor * 1000;
  }
  if (valor === null || valor < meta.minimo || valor > meta.maximo) {
    return `No me quedó claro el número de tu meta de ${meta.etiqueta} 🤔 Probá escribiendo, por ejemplo: "${meta.ejemplo}"`;
  }

  await guardarDatoDeUsuario(chatId, meta.columna, valor);
  return `Listo, tu meta de ${meta.etiqueta} es ${meta.mostrar(valor)} ✅`;
}

// Para los comandos (/meta_peso 85).
async function cambiarMeta(ctx, nombreMeta, valor) {
  const texto = await guardarUnaMeta(ctx.usuario.chatId, nombreMeta, valor);
  await ctx.reply(texto, { reply_markup: tecladoPrincipal });
}

// Para las frases: guarda todas las metas que trae el mensaje y las confirma en una sola respuesta.
// Devuelve true si había alguna.
async function cambiarMetas(ctx, metas) {
  const nombres = Object.keys(METAS).filter((nombre) => metas[nombre] !== null);
  if (nombres.length === 0) return false;

  const textos = [];
  for (const nombre of nombres) {
    textos.push(await guardarUnaMeta(ctx.usuario.chatId, nombre, metas[nombre]));
  }
  await ctx.reply(textos.join('\n'), { reply_markup: tecladoPrincipal });

  // Releemos a la persona para que lo que sigue (por ejemplo, el avance del peso) ya use las metas nuevas.
  ctx.usuario = await obtenerUsuario(ctx.usuario.chatId);
  return true;
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
  const mlAntes = await aguaDelDia(usuario.chatId, hoy);
  await guardarAgua(usuario.chatId, ml);
  await ctx.reply(await mensajeAgua(usuario, mlAntes, mlAntes + ml, hoy), opciones);
}

async function registrarPeso(ctx, kg) {
  const { usuario } = ctx;
  // Un número fuera de este rango seguramente es un error de tipeo o de lectura.
  if (kg < 20 || kg > 300) {
    await ctx.reply(`${kg} kg no me parece un peso correcto 🤔 Probá de nuevo (ej: 72.5).`);
    return;
  }
  // Se leen antes de guardar, para comparar contra los pesos anteriores y no contra este.
  const pesoInicial = await primerPeso(usuario.chatId);
  const pesoAnterior = await ultimoPeso(usuario.chatId);
  const minimoAnterior = await pesoMinimo(usuario.chatId);
  await guardarPeso(usuario.chatId, kg);
  await actualizarSiCorresponde(usuario, hoyLocal());
  const mensaje = await mensajePeso({ usuario, kg, fecha: hoyLocal(), pesoInicial, pesoAnterior, minimoAnterior });
  await ctx.reply(mensaje, { reply_markup: tecladoPrincipal });
}

async function registrarComida(ctx, comida, analisis, fechaHora, fotoPath) {
  const { usuario } = ctx;
  const tipoComida = tipoComidaSegunHora(fechaHora);
  const idComida = await guardarComida({ chatId: usuario.chatId, fechaHora, tipoComida, fotoPath, ...comida });

  // Usamos el día del mensaje: si llegó 23:59 y terminamos 00:00, sigue contando para ese día.
  const fecha = fechaHora.slice(0, 10);
  await actualizarSiCorresponde(usuario, fecha);
  const mensaje = await mensajeComida({
    usuario,
    encabezado: `Anotado: ${tipoComida} ~${enKcal(comida.totales.kcal)} kcal ✅`,
    comida,
    fecha,
    descripcion: analisis.descripcion,
    consejo: analisis.consejo,
    esPrimeraDelDia: (await comidasDelDia(usuario.chatId, fecha)).length === 1,
  });
  await ctx.reply(mensaje, { reply_markup: tecladoCorreccion(idComida) });
}

async function registrarEjercicios(ctx, ejercicios, fechaHora) {
  for (const ejercicio of ejercicios) {
    // Más de 3.000 kcal en una sola actividad seguramente es un error de estimación.
    if (ejercicio.kcal <= 0 || ejercicio.kcal > 3000) {
      await ctx.reply(`No me cerró la cuenta de "${ejercicio.descripcion}" 🤔 Contame qué hiciste y cuánto duró.`);
      continue;
    }
    const id = await guardarEjercicio({ chatId: ctx.usuario.chatId, fechaHora, ...ejercicio });
    await actualizarSiCorresponde(ctx.usuario, fechaHora.slice(0, 10));
    const texto = await mensajeEjercicio(ctx.usuario, ejercicio, fechaHora.slice(0, 10));
    await ctx.reply(texto, { reply_markup: new InlineKeyboard().text('🗑️ Borrar', `borrar-ejercicio:${id}`) });
  }
}

// ---------- Charla para calcular la TMB ----------
//
// El bot pregunta de a un dato y anota cada respuesta. No pregunta lo que ya sabe, y qué le
// preguntó queda guardado en la base (pregunta_pendiente), así la charla sobrevive a un reinicio.

const LIMITES_TMB = { edad: { minimo: 15, maximo: 110 }, altura: { minimo: 100, maximo: 230 }, peso: { minimo: 20, maximo: 300 } };

const botonCancelarTmb = new InlineKeyboard().text('❌ Dejar para después', 'tmb-cancelar');

async function hacerPreguntaTmb(ctx, pregunta) {
  ctx.yaPreguntoTmb = true;
  if (pregunta === 'sexo') {
    const botones = new InlineKeyboard().text('👩 Mujer', 'tmb-sexo:mujer').text('👨 Hombre', 'tmb-sexo:hombre').row().text('❌ Dejar para después', 'tmb-cancelar');
    await ctx.reply('🔥 Calculemos tu TMB: las calorías que tu cuerpo gasta en reposo.\n\nLa fórmula cambia según el sexo biológico. ¿Cuál es el tuyo?', { reply_markup: botones });
  } else if (pregunta === 'edad') {
    await ctx.reply('¿Cuántos años tenés?', { reply_markup: botonCancelarTmb });
  } else if (pregunta === 'altura') {
    await ctx.reply('¿Cuánto medís? (ej: 1,65)', { reply_markup: botonCancelarTmb });
  } else {
    await ctx.reply('¿Cuánto pesás hoy? (ej: 72.5)', { reply_markup: botonCancelarTmb });
  }
}

// Hace la próxima pregunta que falte. Si ya tiene todo, muestra el resultado.
async function continuarTmb(ctx) {
  const usuario = await obtenerUsuario(ctx.usuario.chatId);
  ctx.usuario = usuario;
  const kg = await ultimoPeso(usuario.chatId);

  let falta = null;
  if (!usuario.sexo) falta = 'sexo';
  else if (!usuario.anioNacimiento) falta = 'edad';
  else if (!usuario.alturaCm) falta = 'altura';
  else if (kg === null) falta = 'peso';

  await guardarDatoDeUsuario(usuario.chatId, 'pregunta_pendiente', falta);
  ctx.usuario.preguntaPendiente = falta;
  if (falta) {
    await hacerPreguntaTmb(ctx, falta);
    return;
  }
  ctx.yaPreguntoTmb = true;
  // Con los datos completos (o corregidos) se recalcula el historial con la TMB correcta.
  await recalcularHistorial(usuario);
  const botones = new InlineKeyboard().text('✏️ Actualizar mis datos', 'tmb-actualizar');
  await ctx.reply(textoTmb(usuario, kg, hoyLocal()), { reply_markup: botones });
}

// "tengo 62 años" → 62, "1,65" → 1.65. Solo mira mensajes cortos, para que
// "comí 150 g de arroz" no se tome como una altura de 150.
function numeroDeRespuestaCorta(texto) {
  if (texto.split(/\s+/).length > 4) return null;
  const numero = texto.match(/\d+(?:[.,]\d+)?/);
  return numero ? Number(numero[0].replace(',', '.')) : null;
}

function estaEnRango(valor, { minimo, maximo }) {
  return valor !== null && valor >= minimo && valor <= maximo;
}

// La edad se guarda como año de nacimiento, para que la TMB siga bien con el paso de los años.
function anioDeNacimiento(edad) {
  return Number(hoyLocal().slice(0, 4)) - Math.round(edad);
}

// 1,65 → 165. Quien responde en metros escribe un número menor a 3.
function enCentimetros(altura) {
  return altura !== null && altura < 3 ? Math.round(altura * 100) : altura;
}

// Intenta tomar el texto como respuesta a la pregunta pendiente. Si no lo es (por ejemplo,
// cuenta lo que comió), devuelve false para que el mensaje se procese normalmente.
async function responderPreguntaTmb(ctx, pregunta, texto) {
  const { chatId } = ctx.usuario;
  const numero = numeroDeRespuestaCorta(texto);

  if (pregunta === 'sexo') {
    const sexo = /mujer|femenin/i.test(texto) ? 'mujer' : /hombre|masculin|var[oó]n/i.test(texto) ? 'hombre' : null;
    if (!sexo) return false;
    await guardarDatoDeUsuario(chatId, 'sexo', sexo);
  } else if (pregunta === 'edad') {
    if (!Number.isInteger(numero) || !estaEnRango(numero, LIMITES_TMB.edad)) return false;
    await guardarDatoDeUsuario(chatId, 'anio_nacimiento', anioDeNacimiento(numero));
  } else if (pregunta === 'altura') {
    const altura = enCentimetros(numero);
    if (!estaEnRango(altura, LIMITES_TMB.altura)) return false;
    await guardarDatoDeUsuario(chatId, 'altura_cm', altura);
  } else {
    if (!estaEnRango(numero, LIMITES_TMB.peso)) return false;
    await registrarPeso(ctx, numero);
  }

  await continuarTmb(ctx);
  return true;
}

// Guarda los datos personales que Claude encontró en un mensaje libre. Devuelve true si había alguno.
async function guardarDatosPersonales(ctx, datos) {
  const { chatId } = ctx.usuario;
  let huboDatos = false;
  if (datos.sexo) {
    await guardarDatoDeUsuario(chatId, 'sexo', datos.sexo);
    huboDatos = true;
  }
  if (estaEnRango(datos.edad, LIMITES_TMB.edad)) {
    await guardarDatoDeUsuario(chatId, 'anio_nacimiento', anioDeNacimiento(datos.edad));
    huboDatos = true;
  }
  if (estaEnRango(datos.altura_cm, LIMITES_TMB.altura)) {
    await guardarDatoDeUsuario(chatId, 'altura_cm', datos.altura_cm);
    huboDatos = true;
  }
  return huboDatos;
}

// Anota todo lo que entendió Claude: un mismo mensaje puede traer metas, peso, agua, ejercicio,
// comida y datos personales. Sirve igual para fotos y para textos.
async function responderAnalisis(ctx, analisis, fechaHora, fotoPath = null) {
  // A veces Claude agrega una entrada vacía a las listas: esas no se anotan.
  const ejercicios = analisis.ejercicios.filter((ejercicio) => ejercicio.descripcion && ejercicio.kcal > 0);
  const items = analisis.items.filter((item) => item.nombre && item.gramos > 0);

  // La comida se calcula antes de anotar nada, porque depende de USDA. Si USDA falla, no queda
  // nada a medias y al reintentar no se duplican el peso ni el agua.
  const comida = items.length > 0 ? await calcularComida(items) : null;

  // Las metas van primero, así el mensaje del peso ya muestra el avance hacia la meta nueva.
  // Los datos personales, antes de las calorías, para que el balance ya use la TMB.
  const huboMetas = await cambiarMetas(ctx, analisis.metas);
  const huboDatos = await guardarDatosPersonales(ctx, analisis.datos);
  ctx.usuario = await obtenerUsuario(ctx.usuario.chatId);
  if (analisis.kg) await registrarPeso(ctx, analisis.kg);
  if (analisis.agua_ml) await sumarAgua(ctx, analisis.agua_ml);
  await registrarEjercicios(ctx, ejercicios, fechaHora);
  if (comida) await registrarComida(ctx, comida, analisis, fechaHora, fotoPath);
  if (analisis.respuesta) await ctx.reply(analisis.respuesta, { reply_markup: tecladoPrincipal });

  const quiereTmb = analisis.calcular_tmb || huboDatos;
  if (quiereTmb) await continuarTmb(ctx);

  const anotoAlgo = huboMetas || analisis.kg || analisis.agua_ml || ejercicios.length > 0 || comida;
  if (!anotoAlgo && !analisis.respuesta && !quiereTmb) {
    await ctx.reply(`No te entendí 🤔\n\n${AYUDA}`, { reply_markup: tecladoPrincipal });
  }
}

// Qué hace cada botón fijo. Se revisa antes de llamar a Claude, así tocar un botón no cuesta nada.
const ACCIONES_DE_BOTONES = {
  [BOTONES.vaso]: (ctx) => sumarAgua(ctx, config.vasoMl),
  [BOTONES.comoVoy]: async (ctx) => {
    const progreso = await textoProgresoGrasa(ctx.usuario);
    const texto = `📊 Tu día hasta ahora\n\n${await resumenDelDia(ctx.usuario, hoyLocal())}${progreso ? `\n\n${progreso}` : ''}`;
    await ctx.reply(texto, { reply_markup: tecladoPrincipal });
  },
  [BOTONES.ejercicio]: (ctx) =>
    ctx.reply('¿Qué hiciste y cuánto duró? Contámelo como te salga (ej: "caminé 40 minutos" o "hice una hora de gym tranqui") 🏃', {
      reply_markup: tecladoPrincipal,
    }),
  [BOTONES.tmb]: (ctx) => continuarTmb(ctx),
  [BOTONES.metas]: (ctx) => ctx.reply(textoMetas(ctx.usuario), { reply_markup: tecladoPrincipal }),
  [BOTONES.ayuda]: (ctx) => ctx.reply(AYUDA, { reply_markup: tecladoPrincipal }),
};

async function procesarFoto(ctx) {
  await ctx.reply('Mirando la foto… 👀');

  const fechaHora = ahoraLocal();
  const imagen = await descargarFoto(ctx);
  const fotoPath = guardarFotoEnDisco(imagen, ctx.usuario.chatId, fechaHora, ctx.message.message_id);
  // Las fotos comprimidas de Telegram siempre llegan como JPEG.
  const contexto = await contextoDelDia(ctx.usuario, fechaHora);
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

  // Si el bot le había hecho una pregunta de la TMB, primero vemos si esto es la respuesta.
  const pregunta = ctx.usuario.preguntaPendiente;
  if (pregunta && (await responderPreguntaTmb(ctx, pregunta, texto))) return;

  await procesarMensajeLibre(ctx, texto);

  // Contó otra cosa en el medio de la charla: lo anotamos y volvemos a preguntar.
  if (pregunta && !ctx.yaPreguntoTmb) await hacerPreguntaTmb(ctx, pregunta);
}

async function procesarMensajeLibre(ctx, texto) {
  // Un número solo ("72.5", "72,5" o "72.5 kg") es un peso: no hace falta preguntarle a Claude.
  const peso = texto.match(/^(\d{2,3}(?:[.,]\d{1,2})?)\s*(kg)?$/i);
  if (peso) {
    await registrarPeso(ctx, Number(peso[1].replace(',', '.')));
    return;
  }

  await ctx.replyWithChatAction('typing');
  const fechaHora = ahoraLocal();
  const analisis = await analizarTexto(texto, await contextoDelDia(ctx.usuario, fechaHora));
  await responderAnalisis(ctx, analisis, fechaHora);
}

// Botones "Era menos" / "Era más": escala la porción y manda la comida corregida.
async function corregirPorcion(ctx) {
  const [, accion, id] = ctx.match;
  const comida = await comidaPorId(ctx.usuario.chatId, Number(id));
  if (!comida) {
    await ctx.answerCallbackQuery({ text: 'Esa comida ya no está 🤔' });
    return;
  }

  // 0.8 y 1.25 son inversos (0.8 × 1.25 = 1): tocar "menos" y después "más" vuelve al valor original.
  const corregida = escalarComida(comida, accion === 'mas' ? 1.25 : 0.8);
  await actualizarComida(comida.id, corregida.items, corregida.totales);
  await actualizarSiCorresponde(ctx.usuario, comida.fecha_hora.slice(0, 10));
  await ctx.answerCallbackQuery({ text: 'Corregido ✅' });

  const mensaje = await mensajeComida({
    usuario: ctx.usuario,
    encabezado: `Corregido: ${comida.tipo_comida} ~${enKcal(corregida.totales.kcal)} kcal ✅`,
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
    await registrarUsuario(chatId, ctx.from?.first_name ?? null);
    // Dejamos a la persona (con sus metas) en el contexto, para que cada handler sepa de quién son los datos.
    ctx.usuario = await obtenerUsuario(chatId);
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
  bot.command('tmb', ACCIONES_DE_BOTONES[BOTONES.tmb]);
  bot.command('agua', (ctx) => sumarAgua(ctx, config.vasoMl));
  bot.command('meta_peso', (ctx) => cambiarMeta(ctx, 'peso', numeroDelComando(ctx)));
  bot.command('meta_kcal', (ctx) => cambiarMeta(ctx, 'kcal', numeroDelComando(ctx)));
  bot.command('meta_agua', (ctx) => cambiarMeta(ctx, 'agua', numeroDelComando(ctx)));

  bot.callbackQuery('agua', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '+1 vaso 💧' });
    await sumarAgua(ctx, config.vasoMl, { reply_markup: tecladoAgua });
  });

  bot.callbackQuery(/^tmb-sexo:(mujer|hombre)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await guardarDatoDeUsuario(ctx.usuario.chatId, 'sexo', ctx.match[1]);
    await continuarTmb(ctx);
  });

  bot.callbackQuery('tmb-cancelar', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await guardarDatoDeUsuario(ctx.usuario.chatId, 'pregunta_pendiente', null);
    await ctx.reply('Listo, lo dejamos para después. Lo que ya me contaste queda guardado: cuando quieras tocá "🔥 Mi TMB" 👍', { reply_markup: tecladoPrincipal });
  });

  // Se vuelven a preguntar sexo, edad y altura. El peso no: siempre se usa el último anotado.
  bot.callbackQuery('tmb-actualizar', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    for (const columna of ['sexo', 'anio_nacimiento', 'altura_cm']) {
      await guardarDatoDeUsuario(ctx.usuario.chatId, columna, null);
    }
    await continuarTmb(ctx);
  });

  bot.callbackQuery(/^borrar-ejercicio:(\d+)$/, async (ctx) => {
    const fecha = await borrarEjercicio(ctx.usuario.chatId, Number(ctx.match[1]));
    if (fecha) await actualizarSiCorresponde(ctx.usuario, fecha);
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.answerCallbackQuery({ text: fecha ? 'Borrado 🗑️' : 'Ese ejercicio ya no está 🤔' });
    if (fecha) await ctx.reply('Listo, borré ese ejercicio 🗑️', { reply_markup: tecladoPrincipal });
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
    const comida = await comidaPorId(ctx.usuario.chatId, Number(ctx.match[1]));
    await ctx.editMessageReplyMarkup().catch(() => {});
    if (!comida) {
      await ctx.answerCallbackQuery({ text: 'Esa comida ya no está 🤔' });
      return;
    }

    await borrarComida(comida.id);
    await actualizarSiCorresponde(ctx.usuario, comida.fecha_hora.slice(0, 10));
    await ctx.answerCallbackQuery({ text: 'Borrada 🗑️' });
    const kcal = await kcalDelDia(ctx.usuario.chatId, comida.fecha_hora.slice(0, 10));
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
