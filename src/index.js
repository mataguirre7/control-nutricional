// Punto de entrada: arranca el bot, la API y los recordatorios.
import { verificarVariables, VARIABLES_OBLIGATORIAS } from './config.js';
import { prepararBase, cerrarBase } from './db.js';
import { crearBot } from './bot.js';
import { iniciarRecordatorios } from './reminders.js';
import { iniciarApi } from './api.js';

verificarVariables(VARIABLES_OBLIGATORIAS);

// Crea las tablas si no existen. Si la base no responde (todavía arrancando, contraseña
// mal), cortamos el proceso con un mensaje claro y Docker lo vuelve a intentar.
try {
  await prepararBase();
} catch (error) {
  console.error('No me pude conectar a la base de datos. ¿Están bien las variables POSTGRES_* del .env?', error.message);
  process.exit(1);
}

const bot = crearBot();
iniciarRecordatorios(bot);
iniciarApi();

// Long polling: el bot le pregunta a Telegram si hay mensajes nuevos (no hace falta webhook).
// Si no puede arrancar (token inválido, sin internet), cortamos el proceso
// para que se note en los logs y Docker lo reinicie.
bot
  .start({ onStart: (info) => console.log(`Bot @${info.username} escuchando mensajes`) })
  .catch((error) => {
    // 409: otra copia del bot (por ejemplo en otra compu) está usando el mismo token.
    const motivo =
      error.error_code === 409
        ? 'Hay otra copia del bot corriendo con el mismo token (¿quedó prendido en otra compu?).'
        : '¿Está bien el TELEGRAM_BOT_TOKEN?';
    console.error(`El bot no pudo arrancar. ${motivo}`, error.message);
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
    await cerrarBase();
    process.exit(0);
  });
}
