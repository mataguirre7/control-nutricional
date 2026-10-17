// Toda la configuración sale del archivo .env y queda en un solo objeto.
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

// Rutas relativas a donde se ejecuta el programa (en Docker es /app).
export const CARPETA_DATOS = 'data';
export const CARPETA_FOTOS = 'data/fotos';

// Meta de agua para quien todavía no configuró la suya con /meta_agua.
export const META_AGUA_POR_DEFECTO = 2000;

// Sin estas variables el sistema completo no puede funcionar.
export const VARIABLES_OBLIGATORIAS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_IDS',
  'ANTHROPIC_API_KEY',
  'USDA_API_KEY',
  'API_KEY',
];

// Convierte "08:00,12:30" en ["08:00", "12:30"]. Sirve para cualquier lista separada por coma.
function listaDeHorarios(valor) {
  return valor.split(',').map((hora) => hora.trim()).filter(Boolean);
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  // Las personas que pueden usar el bot. Cada una tiene sus propios datos y metas.
  telegramChatIds: listaDeHorarios(process.env.TELEGRAM_CHAT_IDS || ''),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  usdaApiKey: process.env.USDA_API_KEY,
  apiKey: process.env.API_KEY,
  port: Number(process.env.PORT || 3000),
  vasoMl: Number(process.env.VASO_ML || 250),

  // Resumen de cada noche y resumen semanal (este último, los domingos).
  resumenDiario: listaDeHorarios(process.env.RESUMEN_DIARIO || '22:30'),
  resumenSemanal: listaDeHorarios(process.env.RESUMEN_SEMANAL || '20:00'),

  // Horarios de los recordatorios (HH:MM, hora argentina). Cada uno acepta varios separados por coma.
  recordatorios: {
    desayuno: listaDeHorarios(process.env.RECORDATORIO_DESAYUNO || '08:30'),
    almuerzo: listaDeHorarios(process.env.RECORDATORIO_ALMUERZO || '13:00'),
    merienda: listaDeHorarios(process.env.RECORDATORIO_MERIENDA || '17:30'),
    cena: listaDeHorarios(process.env.RECORDATORIO_CENA || '21:00'),
    agua: listaDeHorarios(process.env.RECORDATORIO_AGUA || '10:00,12:00,15:00,17:00,19:00'),
    peso: listaDeHorarios(process.env.RECORDATORIO_PESO || '08:00'),
  },
};

// Rangos horarios para deducir el tipo de comida sin preguntarle nada a nadie.
// "desde" incluido, "hasta" excluido. Lo que no cae en ningún rango (la noche) es cena.
export const RANGOS_COMIDAS = [
  { tipo: 'desayuno', desde: 5, hasta: 11 },
  { tipo: 'almuerzo', desde: 11, hasta: 16 },
  { tipo: 'merienda', desde: 16, hasta: 20 },
];

// Corta el programa con un mensaje claro si falta alguna variable.
// Recibe la lista porque el script probar-foto solo necesita algunas.
export function verificarVariables(nombres) {
  const faltan = nombres.filter((nombre) => !process.env[nombre]);
  if (faltan.length > 0) {
    console.error(`Faltan variables en el .env: ${faltan.join(', ')}`);
    process.exit(1);
  }
}
