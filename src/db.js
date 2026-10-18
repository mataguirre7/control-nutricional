// Base de datos Postgres: creación de tablas y funciones de lectura/escritura.
// Cada registro guarda el chat_id de la persona, así los datos de cada una quedan separados.
//
// Todas las funciones son async (Postgres responde por la red): siempre se llaman con await.
import fs from 'node:fs';
import pg from 'pg';
import { config, CARPETA_FOTOS, ZONA_HORARIA, META_AGUA_POR_DEFECTO } from './config.js';

// Crea data/fotos/ si todavía no existe (las fotos se guardan en disco, no en la base).
fs.mkdirSync(CARPETA_FOTOS, { recursive: true });

// Las fechas se guardan como timestamp (así en DBeaver se pueden filtrar por fecha), pero
// siempre en hora argentina y sin zona horaria. Le pedimos a pg que las devuelva como el texto
// tal cual ("2026-10-16 13:05:00") en vez de convertirlas a Date, que les aplicaría la zona
// horaria del servidor y movería la hora. 1114 = timestamp, 1082 = date.
pg.types.setTypeParser(1114, (texto) => texto);
pg.types.setTypeParser(1082, (texto) => texto);

const pool = new pg.Pool(config.db);

// Atajo: corre una consulta y devuelve las filas.
async function filas(sql, parametros = []) {
  const resultado = await pool.query(sql, parametros);
  return resultado.rows;
}

// Atajo: corre una consulta y devuelve la primera fila (o null).
async function fila(sql, parametros = []) {
  const resultado = await pool.query(sql, parametros);
  return resultado.rows[0] ?? null;
}

// Corre varias consultas como una sola: o se guardan todas, o ninguna.
// "trabajo" recibe un cliente propio (en una transacción no se puede usar el pool directo).
async function enTransaccion(trabajo) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

// Crea las tablas si no existen. Se llama una vez al arrancar.
export async function prepararBase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      chat_id       TEXT PRIMARY KEY,
      nombre        TEXT,
      peso_objetivo DOUBLE PRECISION,
      meta_kcal     DOUBLE PRECISION,
      meta_agua_ml  INTEGER
    );

    CREATE TABLE IF NOT EXISTS comidas (
      id           SERIAL PRIMARY KEY,
      chat_id      TEXT NOT NULL,
      fecha_hora   TIMESTAMP NOT NULL,
      tipo_comida  TEXT NOT NULL,
      foto_path    TEXT,
      totales_json JSONB NOT NULL,
      confianza    DOUBLE PRECISION
    );

    CREATE TABLE IF NOT EXISTS comida_items (
      id              SERIAL PRIMARY KEY,
      comida_id       INTEGER NOT NULL REFERENCES comidas(id) ON DELETE CASCADE,
      nombre          TEXT NOT NULL,
      gramos          DOUBLE PRECISION NOT NULL,
      nutrientes_json JSONB NOT NULL,
      fuente          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agua (
      id         SERIAL PRIMARY KEY,
      chat_id    TEXT NOT NULL,
      fecha_hora TIMESTAMP NOT NULL,
      ml         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peso (
      id         SERIAL PRIMARY KEY,
      chat_id    TEXT NOT NULL,
      fecha_hora TIMESTAMP NOT NULL,
      kg         DOUBLE PRECISION NOT NULL
    );
  `);
}

// Para cerrar las conexiones al apagar el programa (o al terminar un script).
export function cerrarBase() {
  return pool.end();
}

// ---------- Fechas ----------

// La hora argentina como texto: "2026-10-16 13:05:00".
// El formato de Suecia (sv-SE) da justo ese formato, que Postgres entiende como timestamp.
export function ahoraLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: ZONA_HORARIA });
}

export function hoyLocal() {
  return ahoraLocal().slice(0, 10);
}

// sumarDias("2026-10-16", -1) → "2026-10-15"
// Se calcula en UTC para que ningún cambio de horario saltee o repita un día.
export function sumarDias(fecha, dias) {
  const dia = new Date(`${fecha}T00:00:00Z`);
  dia.setUTCDate(dia.getUTCDate() + dias);
  return dia.toISOString().slice(0, 10);
}

// ---------- Usuarios y metas ----------

// Crea a la persona la primera vez que escribe, y le actualiza el nombre de Telegram cada vez.
export async function registrarUsuario(chatId, nombre) {
  await pool.query(
    `INSERT INTO usuarios (chat_id, nombre) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [chatId, nombre]
  );
}

// Datos y metas de una persona. "registrado" es false si nunca le escribió al bot
// (en ese caso Telegram no nos deja mandarle mensajes).
export async function obtenerUsuario(chatId) {
  const usuario = await fila('SELECT * FROM usuarios WHERE chat_id = $1', [chatId]);
  return {
    chatId,
    registrado: usuario !== null,
    nombre: usuario?.nombre ?? null,
    pesoObjetivo: usuario?.peso_objetivo ?? null,
    metaKcal: usuario?.meta_kcal ?? null,
    metaAguaMl: usuario?.meta_agua_ml ?? META_AGUA_POR_DEFECTO,
  };
}

const COLUMNAS_DE_METAS = ['peso_objetivo', 'meta_kcal', 'meta_agua_ml'];

// Guarda una meta de la persona. valor null borra la meta.
export async function guardarMeta(chatId, columna, valor) {
  // El nombre de una columna no puede ir como parámetro "$1", así que lo validamos contra una lista fija.
  if (!COLUMNAS_DE_METAS.includes(columna)) {
    throw new Error(`Meta desconocida: ${columna}`);
  }
  await pool.query(
    `INSERT INTO usuarios (chat_id, ${columna}) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET ${columna} = EXCLUDED.${columna}`,
    [chatId, valor]
  );
}

// ---------- Agua ----------

export async function guardarAgua(chatId, ml) {
  await pool.query('INSERT INTO agua (chat_id, fecha_hora, ml) VALUES ($1, $2, $3)', [chatId, ahoraLocal(), ml]);
}

// fecha: "YYYY-MM-DD". SUM devuelve un número grande (bigint) que pg entrega como texto: por eso el ::int.
export async function aguaDelDia(chatId, fecha) {
  const resultado = await fila(
    'SELECT COALESCE(SUM(ml), 0)::int AS total FROM agua WHERE chat_id = $1 AND fecha_hora::date = $2',
    [chatId, fecha]
  );
  return resultado.total;
}

// Días (YYYY-MM-DD) en los que el agua llegó a la meta. Sirve para la racha de agua.
export async function diasConMetaDeAgua(chatId, metaMl) {
  const dias = await filas(
    `SELECT fecha_hora::date AS fecha FROM agua WHERE chat_id = $1
     GROUP BY fecha_hora::date HAVING SUM(ml) >= $2`,
    [chatId, metaMl]
  );
  return dias.map((dia) => dia.fecha);
}

// ---------- Peso ----------

export async function guardarPeso(chatId, kg) {
  await pool.query('INSERT INTO peso (chat_id, fecha_hora, kg) VALUES ($1, $2, $3)', [chatId, ahoraLocal(), kg]);
}

// Primer peso registrado (el punto de partida para medir el avance), o null si no hay ninguno.
export async function primerPeso(chatId) {
  const resultado = await fila('SELECT kg FROM peso WHERE chat_id = $1 ORDER BY fecha_hora, id LIMIT 1', [chatId]);
  return resultado?.kg ?? null;
}

// Último peso registrado (de cualquier día), o null si no hay ninguno.
export async function ultimoPeso(chatId) {
  const resultado = await fila('SELECT kg FROM peso WHERE chat_id = $1 ORDER BY fecha_hora DESC, id DESC LIMIT 1', [chatId]);
  return resultado?.kg ?? null;
}

// El peso más bajo registrado hasta ahora, o null. Sirve para no repetir logros de peso.
export async function pesoMinimo(chatId) {
  const resultado = await fila('SELECT MIN(kg) AS kg FROM peso WHERE chat_id = $1', [chatId]);
  return resultado.kg;
}

// Promedio de peso entre dos fechas (inclusive), o null si no se pesó en ese período.
export async function promedioPeso(chatId, desde, hasta) {
  const resultado = await fila(
    'SELECT AVG(kg) AS kg FROM peso WHERE chat_id = $1 AND fecha_hora::date BETWEEN $2 AND $3',
    [chatId, desde, hasta]
  );
  return resultado.kg;
}

// Devuelve el último peso del día ({ kg, fecha_hora }) o null si no se pesó.
export async function ultimoPesoDelDia(chatId, fecha) {
  return fila(
    `SELECT kg, fecha_hora FROM peso WHERE chat_id = $1 AND fecha_hora::date = $2
     ORDER BY fecha_hora DESC, id DESC LIMIT 1`,
    [chatId, fecha]
  );
}

// ---------- Comidas ----------

// Va en una transacción para que nunca quede una comida guardada sin sus items.
// Devuelve el id de la comida nueva (lo usan los botones de corregir/borrar).
export async function guardarComida({ chatId, fechaHora, tipoComida, fotoPath, totales, confianza, items }) {
  return enTransaccion(async (cliente) => {
    const comida = await cliente.query(
      `INSERT INTO comidas (chat_id, fecha_hora, tipo_comida, foto_path, totales_json, confianza)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [chatId, fechaHora, tipoComida, fotoPath, JSON.stringify(totales), confianza]
    );
    const idComida = comida.rows[0].id;

    for (const item of items) {
      await cliente.query(
        `INSERT INTO comida_items (comida_id, nombre, gramos, nutrientes_json, fuente)
         VALUES ($1, $2, $3, $4, $5)`,
        [idComida, item.nombre, item.gramos, JSON.stringify(item.nutrientes), item.fuente]
      );
    }
    return idComida;
  });
}

// Una comida de esa persona con sus items (incluye el id de cada item, para poder actualizarlos), o null.
// Filtrar por chat_id evita que alguien toque una comida que no es suya.
// Las columnas JSONB llegan ya convertidas a objetos: no hace falta JSON.parse.
export async function comidaPorId(chatId, id) {
  const comida = await fila('SELECT * FROM comidas WHERE id = $1 AND chat_id = $2', [id, chatId]);
  if (!comida) return null;

  const items = await filas('SELECT * FROM comida_items WHERE comida_id = $1 ORDER BY id', [id]);
  return {
    id: comida.id,
    fecha_hora: comida.fecha_hora,
    tipo_comida: comida.tipo_comida,
    items: items.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      gramos: item.gramos,
      fuente: item.fuente,
      nutrientes: item.nutrientes_json,
    })),
    totales: comida.totales_json,
  };
}

// Guarda los gramos/nutrientes corregidos de cada item y los nuevos totales.
// Se llama solo con comidas ya leídas con comidaPorId (o sea, de la persona correcta).
export async function actualizarComida(id, items, totales) {
  await enTransaccion(async (cliente) => {
    for (const item of items) {
      await cliente.query('UPDATE comida_items SET gramos = $1, nutrientes_json = $2 WHERE id = $3', [
        item.gramos,
        JSON.stringify(item.nutrientes),
        item.id,
      ]);
    }
    await cliente.query('UPDATE comidas SET totales_json = $1 WHERE id = $2', [JSON.stringify(totales), id]);
  });
}

// Los items se borran solos con la comida (ON DELETE CASCADE en la tabla).
export async function borrarComida(id) {
  await pool.query('DELETE FROM comidas WHERE id = $1', [id]);
}

// Suma las kcal de todas las comidas del día leyendo el campo "kcal" del JSON de totales.
export async function kcalDelDia(chatId, fecha) {
  const resultado = await fila(
    `SELECT COALESCE(SUM((totales_json->>'kcal')::float8), 0) AS total
     FROM comidas WHERE chat_id = $1 AND fecha_hora::date = $2`,
    [chatId, fecha]
  );
  return resultado.total;
}

// ¿Ya anotó ese tipo de comida (desayuno, almuerzo...) en el día? Lo usan los recordatorios.
export async function hayComidaDelTipo(chatId, fecha, tipoComida) {
  const resultado = await fila(
    'SELECT 1 FROM comidas WHERE chat_id = $1 AND fecha_hora::date = $2 AND tipo_comida = $3 LIMIT 1',
    [chatId, fecha, tipoComida]
  );
  return resultado !== null;
}

// Días (YYYY-MM-DD) con al menos una comida anotada. Sirve para la racha.
export async function diasConComidas(chatId) {
  const dias = await filas('SELECT DISTINCT fecha_hora::date AS fecha FROM comidas WHERE chat_id = $1', [chatId]);
  return dias.map((dia) => dia.fecha);
}

// Devuelve las comidas del día con sus items.
export async function comidasDelDia(chatId, fecha) {
  const comidas = await filas(
    'SELECT * FROM comidas WHERE chat_id = $1 AND fecha_hora::date = $2 ORDER BY fecha_hora, id',
    [chatId, fecha]
  );

  const resultado = [];
  for (const comida of comidas) {
    const items = await filas('SELECT * FROM comida_items WHERE comida_id = $1 ORDER BY id', [comida.id]);
    resultado.push({
      id: comida.id,
      fecha_hora: comida.fecha_hora,
      tipo_comida: comida.tipo_comida,
      foto_path: comida.foto_path,
      confianza: comida.confianza,
      items: items.map((item) => ({
        nombre: item.nombre,
        gramos: item.gramos,
        fuente: item.fuente,
        nutrientes: item.nutrientes_json,
      })),
      totales: comida.totales_json,
    });
  }
  return resultado;
}

// Para el script de importación: deja la próxima numeración de cada tabla después del último id.
// Hace falta porque los datos importados traen sus ids originales.
export async function ajustarNumeracion(cliente) {
  for (const tabla of ['comidas', 'comida_items', 'agua', 'peso']) {
    await cliente.query(`SELECT setval(pg_get_serial_sequence('${tabla}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabla}), 0) + 1, false)`);
  }
}

export { enTransaccion };
