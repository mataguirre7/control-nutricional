// API REST mínima para consultar los datos. Protegida con el header x-api-key.
// Con ?chat_id=… devuelve una persona; sin él, devuelve a todas agrupadas.
import express from 'express';
import { config } from './config.js';
import { obtenerUsuario, comidasDelDia, aguaDelDia, ultimoPesoDelDia, sumarDias } from './db.js';
import { sumarNutrientes } from './nutrition.js';

// Límite para que un pedido de rango no recorra años enteros por error.
const MAXIMO_DIAS_RANGO = 366;

function verificarApiKey(req, res, next) {
  if (req.get('x-api-key') !== config.apiKey) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  next();
}

// Acepta solo fechas reales con formato YYYY-MM-DD.
// La segunda comparación descarta fechas como 2026-02-30, que JavaScript "corrige" a marzo.
function esFechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto ?? '')) return false;
  const fecha = new Date(`${texto}T00:00:00Z`);
  return !isNaN(fecha) && fecha.toISOString().slice(0, 10) === texto;
}

// Lista de fechas desde/hasta inclusive: ["2026-10-01", "2026-10-02", ...].
function diasEntre(desde, hasta) {
  const dias = [];
  for (let dia = desde; dia <= hasta; dia = sumarDias(dia, 1)) {
    dias.push(dia);
  }
  return dias;
}

// Arma el JSON completo de un día de una persona.
function armarDia(chatId, fecha) {
  const comidas = comidasDelDia(chatId, fecha);
  return {
    fecha,
    comidas,
    agua_ml: aguaDelDia(chatId, fecha),
    peso: ultimoPesoDelDia(chatId, fecha),
    totales_dia: sumarNutrientes(comidas.map((comida) => comida.totales)),
  };
}

function datosDePersona(chatId) {
  const usuario = obtenerUsuario(chatId);
  return { chat_id: chatId, nombre: usuario.nombre };
}

// Devuelve los chat_id a consultar según ?chat_id=…, o null si ya respondió con un error.
function personasPedidas(req, res) {
  const { chat_id: chatId } = req.query;
  if (chatId === undefined) return config.telegramChatIds;
  if (!config.telegramChatIds.includes(chatId)) {
    res.status(404).json({ error: `No hay ninguna persona con chat_id ${chatId}` });
    return null;
  }
  return [chatId];
}

export function iniciarApi() {
  const app = express();
  app.use('/api', verificarApiKey);

  app.get('/api/usuarios', (req, res) => {
    const usuarios = config.telegramChatIds.map((chatId) => {
      const usuario = obtenerUsuario(chatId);
      return {
        chat_id: chatId,
        nombre: usuario.nombre,
        registrado: usuario.registrado,
        peso_objetivo: usuario.pesoObjetivo,
        meta_kcal: usuario.metaKcal,
        meta_agua_ml: usuario.metaAguaMl,
      };
    });
    res.json(usuarios);
  });

  app.get('/api/dia/:fecha', (req, res) => {
    const { fecha } = req.params;
    if (!esFechaValida(fecha)) {
      return res.status(400).json({ error: 'La fecha tiene que ser YYYY-MM-DD' });
    }
    const chatIds = personasPedidas(req, res);
    if (!chatIds) return;

    if (req.query.chat_id !== undefined) {
      return res.json({ ...datosDePersona(chatIds[0]), ...armarDia(chatIds[0], fecha) });
    }
    res.json({ fecha, usuarios: chatIds.map((chatId) => ({ ...datosDePersona(chatId), ...armarDia(chatId, fecha) })) });
  });

  app.get('/api/rango', (req, res) => {
    const { desde, hasta } = req.query;
    if (!esFechaValida(desde) || !esFechaValida(hasta)) {
      return res.status(400).json({ error: 'Usá ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD' });
    }
    if (desde > hasta) {
      return res.status(400).json({ error: '"desde" no puede ser posterior a "hasta"' });
    }
    const dias = diasEntre(desde, hasta);
    if (dias.length > MAXIMO_DIAS_RANGO) {
      return res.status(400).json({ error: `El rango no puede superar ${MAXIMO_DIAS_RANGO} días` });
    }
    const chatIds = personasPedidas(req, res);
    if (!chatIds) return;

    const persona = (chatId) => ({ ...datosDePersona(chatId), dias: dias.map((dia) => armarDia(chatId, dia)) });
    if (req.query.chat_id !== undefined) {
      return res.json({ desde, hasta, ...persona(chatIds[0]) });
    }
    res.json({ desde, hasta, usuarios: chatIds.map(persona) });
  });

  app.listen(config.port, () => {
    console.log(`API escuchando en el puerto ${config.port}`);
  });
}
