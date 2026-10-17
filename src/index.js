// Punto de entrada: arranca el bot, la API y los recordatorios.
import { verificarVariables, VARIABLES_OBLIGATORIAS } from './config.js';
import { crearBot } from './bot.js';
import { iniciarRecordatorios } from './reminders.js';
import { iniciarApi } from './api.js';

verificarVariables(VARIABLES_OBLIGATORIAS);

const bot = crearBot();
iniciarRecordatorios(bot);
iniciarApi();

// Long polling: el bot le pregunta a Telegram si hay mensajes nuevos (no hace falta webhook).
// Si no puede arrancar (token inválido, sin internet), cortamos el proceso
// para que se note en los logs y Docker lo reinicie.
bot
  .start({ onStart: (info) => console.log(`Bot @${info.username} escuchando mensajes`) })
  .catch((error) => {
    console.error('El bot no pudo arrancar. ¿Está bien el TELEGRAM_BOT_TOKEN?', error.message);
    process.exit(1);
  });

// El menú de comandos que aparece en Telegram al tocar "/" o el botón "Menú".
bot.api
  .setMyCommands([
    { command: 'hoy', description: 'Ver cómo vas hoy 📊' },
    { command: 'agua', description: 'Sumar un vaso de agua 💧' },
    { command: 'metas', description: 'Ver tus metas 🎯' },
    { command: 'start', description: 'Ver qué le podés mandar al bot' },
  ])
  .catch((error) => console.error('No pude configurar el menú de comandos:', error.message));

// Red de seguridad: una promesa rechazada que nadie atrapó no debe tirar el proceso.
process.on('unhandledRejection', (error) => {
  console.error('Error no atrapado:', error);
});

// Al hacer "docker compose down" cortamos el bot ordenadamente.
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.once(senal, async () => {
    await bot.stop();
    process.exit(0);
  });
}
