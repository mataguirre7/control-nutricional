// Recordatorios programados con node-cron, en hora argentina.
import cron from 'node-cron';
import { config, ZONA_HORARIA } from './config.js';
import { tecladoAgua } from './bot.js';

const MENSAJES = {
  desayuno: '☀️ ¡Buen día! ¿Qué desayunaste? Mandame una foto 📸',
  almuerzo: '🍽️ ¿Qué almorzaste? Mandame una foto 📸',
  merienda: '☕ ¿Qué merendaste? Mandame una foto 📸',
  cena: '🌙 ¿Qué cenaste? Mandame una foto 📸',
  agua: '💧 ¡Hora de tomar agua! Tocá el botón cuando tomes un vaso.',
  peso: '⚖️ ¿Te pesaste hoy? Mandame una foto de la balanza o escribí el número (ej: 72.5).',
};

// "08:30" → expresión cron "30 8 * * *" (todos los días a las 8:30).
function expresionCron(hora) {
  const coincidencia = hora.match(/^(\d{1,2}):(\d{2})$/);
  if (!coincidencia || Number(coincidencia[1]) > 23 || Number(coincidencia[2]) > 59) {
    throw new Error(`Horario de recordatorio inválido: "${hora}". Usá el formato HH:MM.`);
  }
  return `${Number(coincidencia[2])} ${Number(coincidencia[1])} * * *`;
}

export function iniciarRecordatorios(bot) {
  for (const [tipo, horarios] of Object.entries(config.recordatorios)) {
    // Solo el recordatorio de agua lleva el botón "+1 vaso".
    const opciones = tipo === 'agua' ? { reply_markup: tecladoAgua } : {};

    for (const hora of horarios) {
      cron.schedule(
        expresionCron(hora),
        async () => {
          try {
            await bot.api.sendMessage(config.telegramChatId, MENSAJES[tipo], opciones);
          } catch (error) {
            console.error(`No pude mandar el recordatorio de ${tipo}:`, error);
          }
        },
        { timezone: ZONA_HORARIA }
      );
    }
  }
  console.log('Recordatorios programados:', config.recordatorios);
}
