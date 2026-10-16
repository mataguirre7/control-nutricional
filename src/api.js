// API REST mínima para consultar los datos. Protegida con el header x-api-key.
import express from 'express';
import { config } from './config.js';
import { comidasDelDia, aguaDelDia, ultimoPesoDelDia } from './db.js';
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
// Se avanza en UTC para que ningún cambio de horario saltee o repita un día.
function diasEntre(desde, hasta) {
  const dias = [];
  const fin = new Date(`${hasta}T00:00:00Z`);
  for (let dia = new Date(`${desde}T00:00:00Z`); dia <= fin; dia.setUTCDate(dia.getUTCDate() + 1)) {
    dias.push(dia.toISOString().slice(0, 10));
  }
  return dias;
}

// Arma el JSON completo de un día.
function armarDia(fecha) {
  const comidas = comidasDelDia(fecha);
  return {
    fecha,
    comidas,
    agua_ml: aguaDelDia(fecha),
    peso: ultimoPesoDelDia(fecha),
    totales_dia: sumarNutrientes(comidas.map((comida) => comida.totales)),
  };
}

export function iniciarApi() {
  const app = express();
  app.use('/api', verificarApiKey);

  app.get('/api/dia/:fecha', (req, res) => {
    const { fecha } = req.params;
    if (!esFechaValida(fecha)) {
      return res.status(400).json({ error: 'La fecha tiene que ser YYYY-MM-DD' });
    }
    res.json(armarDia(fecha));
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
    res.json({ desde, hasta, dias: dias.map(armarDia) });
  });

  app.listen(config.port, () => {
    console.log(`API escuchando en el puerto ${config.port}`);
  });
}
