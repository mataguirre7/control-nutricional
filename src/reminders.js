// Mensajes programados con node-cron, en hora argentina: recordatorios y resúmenes.
// Los horarios son los mismos para todos, pero cada persona recibe lo suyo.
import cron from 'node-cron';
import { config, ZONA_HORARIA } from './config.js';
import { hoyLocal, ahoraLocal, obtenerUsuario, aguaDelDia, hayComidaDelTipo, ultimoPesoDelDia, comidasDelDia } from './db.js';
import { tecladoAgua, tecladoPrincipal } from './bot.js';
import { lineaAgua, contextoDelDia, resumenDelDia, resumenSemanal } from './progreso.js';
import { escribirConsejoParaManana } from './vision.js';

const MENSAJES = {
  desayuno: '☀️ ¡Buen día! ¿Qué desayunaste? Mandame una foto 📸',
  almuerzo: '🍽️ ¿Qué almorzaste? Mandame una foto 📸',
  merienda: '☕ ¿Qué merendaste? Mandame una foto 📸',
  cena: '🌙 ¿Qué cenaste? Mandame una foto 📸',
  agua: '💧 ¡Hora de tomar agua! Tocá "+1 vaso" cuando tomes uno.',
  peso: '⚖️ ¿Te pesaste hoy? Mandame una foto de la balanza o escribí el número (ej: 72.5).',
};

// "08:30" → expresión cron "30 8 * * *" (todos los días a las 8:30).
// diaSemana: "*" todos los días, "0" solo los domingos.
function expresionCron(hora, diaSemana = '*') {
  const coincidencia = hora.match(/^(\d{1,2}):(\d{2})$/);
  if (!coincidencia || Number(coincidencia[1]) > 23 || Number(coincidencia[2]) > 59) {
    throw new Error(`Horario inválido: "${hora}". Usá el formato HH:MM.`);
  }
  return `${Number(coincidencia[2])} ${Number(coincidencia[1])} * * ${diaSemana}`;
}

function programar(hora, tarea, diaSemana = '*') {
  cron.schedule(expresionCron(hora, diaSemana), tarea, { timezone: ZONA_HORARIA });
}

// Corre la tarea para cada persona que ya le escribió al bot (a las demás Telegram no
// nos deja escribirles). Si falla con una persona, las demás reciben igual.
async function paraCadaPersona(nombreTarea, tarea) {
  for (const chatId of config.telegramChatIds) {
    try {
      const usuario = await obtenerUsuario(chatId);
      if (!usuario.registrado) continue;
      await tarea(usuario);
    } catch (error) {
      console.error(`Falló "${nombreTarea}" para el chat ${chatId}:`, error);
    }
  }
}

// ¿Ya hizo hoy lo que le íbamos a recordar? Así no la molestamos de más.
async function yaLoHizo(usuario, tipo, hoy) {
  if (tipo === 'agua') return (await aguaDelDia(usuario.chatId, hoy)) >= usuario.metaAguaMl;
  if (tipo === 'peso') return (await ultimoPesoDelDia(usuario.chatId, hoy)) !== null;
  return hayComidaDelTipo(usuario.chatId, hoy, tipo);
}

async function enviarRecordatorio(bot, usuario, tipo) {
  const hoy = hoyLocal();
  if (await yaLoHizo(usuario, tipo, hoy)) {
    console.log(`Recordatorio de ${tipo} para ${usuario.chatId} salteado: ya lo hizo hoy`);
    return;
  }

  if (tipo === 'agua') {
    const texto = `${MENSAJES.agua}\n\n${lineaAgua(await aguaDelDia(usuario.chatId, hoy), usuario)}`;
    await bot.api.sendMessage(usuario.chatId, texto, { reply_markup: tecladoAgua });
  } else {
    // Mandar los botones fijos con cada recordatorio asegura que siempre los tenga a mano.
    await bot.api.sendMessage(usuario.chatId, MENSAJES[tipo], { reply_markup: tecladoPrincipal });
  }
}

async function enviarResumenDiario(bot, usuario) {
  const hoy = hoyLocal();
  let texto = `🌙 Así fue tu día\n\n${await resumenDelDia(usuario, hoy)}`;

  // El consejo para mañana es un extra: si Claude falla, el resumen sale igual.
  if ((await comidasDelDia(usuario.chatId, hoy)).length > 0) {
    try {
      texto += `\n\n💡 ${await escribirConsejoParaManana(await contextoDelDia(usuario, ahoraLocal()))}`;
    } catch (error) {
      console.error('No pude generar el consejo para mañana:', error);
    }
  } else {
    texto += '\n\n¡Mañana arrancamos de nuevo! 💪';
  }
  await bot.api.sendMessage(usuario.chatId, texto, { reply_markup: tecladoPrincipal });
}

// Cada persona recibe primero su resumen y después el de los demás, para acompañarse entre todos.
// Quien no anotó nada en la semana no tiene resumen (ni propio ni como copia).
async function enviarResumenesSemanales(bot) {
  const hoy = hoyLocal();
  const resumenes = [];
  for (const chatId of config.telegramChatIds) {
    const usuario = await obtenerUsuario(chatId);
    const texto = await resumenSemanal(usuario, hoy);
    if (texto !== null) resumenes.push({ usuario, texto });
  }

  await paraCadaPersona('resumen semanal', async (destinatario) => {
    const propio = resumenes.find((resumen) => resumen.usuario.chatId === destinatario.chatId);
    if (propio) {
      await bot.api.sendMessage(destinatario.chatId, propio.texto);
    }
    for (const { usuario, texto } of resumenes) {
      if (usuario.chatId === destinatario.chatId) continue;
      await bot.api.sendMessage(destinatario.chatId, `👨‍👩‍👧 Así le fue a ${usuario.nombre ?? 'otro integrante'} esta semana\n\n${texto}`);
    }
  });
}

export function iniciarRecordatorios(bot) {
  for (const [tipo, horarios] of Object.entries(config.recordatorios)) {
    for (const hora of horarios) {
      programar(hora, () => paraCadaPersona(`recordatorio de ${tipo}`, (usuario) => enviarRecordatorio(bot, usuario, tipo)));
    }
  }
  for (const hora of config.resumenDiario) {
    programar(hora, () => paraCadaPersona('resumen diario', (usuario) => enviarResumenDiario(bot, usuario)));
  }
  for (const hora of config.resumenSemanal) {
    // Si falla el armado de los resúmenes, se loguea y el resto del bot sigue andando.
    programar(hora, () => enviarResumenesSemanales(bot).catch((error) => console.error('Falló el resumen semanal:', error)), '0');
  }

  console.log('Recordatorios programados:', config.recordatorios);
  console.log(`Resumen diario: ${config.resumenDiario.join(', ')} · Resumen semanal (domingos): ${config.resumenSemanal.join(', ')}`);
  console.log(`Personas habilitadas: ${config.telegramChatIds.join(', ')}`);
}
