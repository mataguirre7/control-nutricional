// Base de datos SQLite: creación de tablas y funciones de lectura/escritura.
// Cada registro guarda el chat_id de la persona, así los datos de cada una quedan separados.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CARPETA_DATOS, CARPETA_FOTOS, ZONA_HORARIA, META_AGUA_POR_DEFECTO } from './config.js';

// Crea data/ y data/fotos/ si todavía no existen.
fs.mkdirSync(CARPETA_FOTOS, { recursive: true });

const db = new Database(path.join(CARPETA_DATOS, 'nutricion.db'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    chat_id       TEXT PRIMARY KEY,
    nombre        TEXT,
    peso_objetivo REAL,
    meta_kcal     REAL,
    meta_agua_ml  INTEGER
  );

  CREATE TABLE IF NOT EXISTS comidas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT,
    fecha_hora   TEXT NOT NULL,
    tipo_comida  TEXT NOT NULL,
    foto_path    TEXT,
    totales_json TEXT NOT NULL,
    confianza    REAL
  );

  CREATE TABLE IF NOT EXISTS comida_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    comida_id       INTEGER NOT NULL REFERENCES comidas(id),
    nombre          TEXT NOT NULL,
    gramos          REAL NOT NULL,
    nutrientes_json TEXT NOT NULL,
    fuente          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agua (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    fecha_hora TEXT NOT NULL,
    ml         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peso (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    fecha_hora TEXT NOT NULL,
    kg         REAL NOT NULL
  );
`);

// Migración: las bases creadas cuando el bot era de una sola persona no tienen chat_id.
// Le agregamos la columna; los registros viejos quedan sin dueño y no aparecen para nadie.
for (const tabla of ['comidas', 'agua', 'peso']) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all().map((columna) => columna.name);
  if (!columnas.includes('chat_id')) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN chat_id TEXT`);
    console.log(`Base de datos: agregué la columna chat_id a la tabla ${tabla}`);
  }
}

// ---------- Fechas ----------

// Las fechas se guardan como texto en hora argentina: "2026-10-16 13:05:00".
// El formato de Suecia (sv-SE) da justo ese formato, y así buscar un día
// es un simple LIKE '2026-10-16%', sin pelear con zonas horarias.
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
export function registrarUsuario(chatId, nombre) {
  db.prepare(
    `INSERT INTO usuarios (chat_id, nombre) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET nombre = excluded.nombre`
  ).run(chatId, nombre);
}

// Datos y metas de una persona. "registrado" es false si nunca le escribió al bot
// (en ese caso Telegram no nos deja mandarle mensajes).
export function obtenerUsuario(chatId) {
  const fila = db.prepare('SELECT * FROM usuarios WHERE chat_id = ?').get(chatId);
  return {
    chatId,
    registrado: fila !== undefined,
    nombre: fila?.nombre ?? null,
    pesoObjetivo: fila?.peso_objetivo ?? null,
    metaKcal: fila?.meta_kcal ?? null,
    metaAguaMl: fila?.meta_agua_ml ?? META_AGUA_POR_DEFECTO,
  };
}

const COLUMNAS_DE_METAS = ['peso_objetivo', 'meta_kcal', 'meta_agua_ml'];

// Guarda una meta de la persona. valor null borra la meta.
export function guardarMeta(chatId, columna, valor) {
  // El nombre de una columna no puede ir como parámetro "?", así que lo validamos contra una lista fija.
  if (!COLUMNAS_DE_METAS.includes(columna)) {
    throw new Error(`Meta desconocida: ${columna}`);
  }
  db.prepare(
    `INSERT INTO usuarios (chat_id, ${columna}) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET ${columna} = excluded.${columna}`
  ).run(chatId, valor);
}

// ---------- Agua ----------

export function guardarAgua(chatId, ml) {
  db.prepare('INSERT INTO agua (chat_id, fecha_hora, ml) VALUES (?, ?, ?)').run(chatId, ahoraLocal(), ml);
}

// fecha: "YYYY-MM-DD"
export function aguaDelDia(chatId, fecha) {
  const fila = db
    .prepare('SELECT COALESCE(SUM(ml), 0) AS total FROM agua WHERE chat_id = ? AND fecha_hora LIKE ?')
    .get(chatId, `${fecha}%`);
  return fila.total;
}

// Días (YYYY-MM-DD) en los que el agua llegó a la meta. Sirve para la racha de agua.
export function diasConMetaDeAgua(chatId, metaMl) {
  return db
    .prepare('SELECT substr(fecha_hora, 1, 10) AS fecha FROM agua WHERE chat_id = ? GROUP BY fecha HAVING SUM(ml) >= ?')
    .all(chatId, metaMl)
    .map((fila) => fila.fecha);
}

// ---------- Peso ----------

export function guardarPeso(chatId, kg) {
  db.prepare('INSERT INTO peso (chat_id, fecha_hora, kg) VALUES (?, ?, ?)').run(chatId, ahoraLocal(), kg);
}

// Primer peso registrado (el punto de partida para medir el avance), o null si no hay ninguno.
export function primerPeso(chatId) {
  const fila = db.prepare('SELECT kg FROM peso WHERE chat_id = ? ORDER BY fecha_hora, id LIMIT 1').get(chatId);
  return fila ? fila.kg : null;
}

// Último peso registrado (de cualquier día), o null si no hay ninguno.
export function ultimoPeso(chatId) {
  const fila = db.prepare('SELECT kg FROM peso WHERE chat_id = ? ORDER BY fecha_hora DESC, id DESC LIMIT 1').get(chatId);
  return fila ? fila.kg : null;
}

// El peso más bajo registrado hasta ahora, o null. Sirve para no repetir logros de peso.
export function pesoMinimo(chatId) {
  return db.prepare('SELECT MIN(kg) AS kg FROM peso WHERE chat_id = ?').get(chatId).kg;
}

// Promedio de peso entre dos fechas (inclusive), o null si no se pesó en ese período.
export function promedioPeso(chatId, desde, hasta) {
  return db
    .prepare('SELECT AVG(kg) AS kg FROM peso WHERE chat_id = ? AND substr(fecha_hora, 1, 10) BETWEEN ? AND ?')
    .get(chatId, desde, hasta).kg;
}

// Devuelve el último peso del día ({ kg, fecha_hora }) o null si no se pesó.
export function ultimoPesoDelDia(chatId, fecha) {
  const fila = db
    .prepare('SELECT kg, fecha_hora FROM peso WHERE chat_id = ? AND fecha_hora LIKE ? ORDER BY fecha_hora DESC, id DESC LIMIT 1')
    .get(chatId, `${fecha}%`);
  return fila ?? null;
}

// ---------- Comidas ----------

// Va en una transacción para que nunca quede una comida guardada sin sus items.
// Devuelve el id de la comida nueva (lo usan los botones de corregir/borrar).
export const guardarComida = db.transaction(({ chatId, fechaHora, tipoComida, fotoPath, totales, confianza, items }) => {
  const comida = db
    .prepare(
      `INSERT INTO comidas (chat_id, fecha_hora, tipo_comida, foto_path, totales_json, confianza)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(chatId, fechaHora, tipoComida, fotoPath, JSON.stringify(totales), confianza);

  const insertarItem = db.prepare(
    `INSERT INTO comida_items (comida_id, nombre, gramos, nutrientes_json, fuente)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const item of items) {
    insertarItem.run(comida.lastInsertRowid, item.nombre, item.gramos, JSON.stringify(item.nutrientes), item.fuente);
  }
  return Number(comida.lastInsertRowid);
});

// Una comida de esa persona con sus items (incluye el id de cada item, para poder actualizarlos), o null.
// Filtrar por chat_id evita que alguien toque una comida que no es suya.
export function comidaPorId(chatId, id) {
  const comida = db.prepare('SELECT * FROM comidas WHERE id = ? AND chat_id = ?').get(id, chatId);
  if (!comida) return null;

  const items = db.prepare('SELECT * FROM comida_items WHERE comida_id = ? ORDER BY id').all(id);
  return {
    id: comida.id,
    fecha_hora: comida.fecha_hora,
    tipo_comida: comida.tipo_comida,
    items: items.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      gramos: item.gramos,
      fuente: item.fuente,
      nutrientes: JSON.parse(item.nutrientes_json),
    })),
    totales: JSON.parse(comida.totales_json),
  };
}

// Guarda los gramos/nutrientes corregidos de cada item y los nuevos totales.
// Se llama solo con comidas ya leídas con comidaPorId (o sea, de la persona correcta).
export const actualizarComida = db.transaction((id, items, totales) => {
  const actualizarItem = db.prepare('UPDATE comida_items SET gramos = ?, nutrientes_json = ? WHERE id = ?');
  for (const item of items) {
    actualizarItem.run(item.gramos, JSON.stringify(item.nutrientes), item.id);
  }
  db.prepare('UPDATE comidas SET totales_json = ? WHERE id = ?').run(JSON.stringify(totales), id);
});

// Primero los items y después la comida, porque los items apuntan a ella.
export const borrarComida = db.transaction((id) => {
  db.prepare('DELETE FROM comida_items WHERE comida_id = ?').run(id);
  db.prepare('DELETE FROM comidas WHERE id = ?').run(id);
});

// Suma las kcal de todas las comidas del día leyendo el campo "kcal" del JSON de totales.
export function kcalDelDia(chatId, fecha) {
  const fila = db
    .prepare(
      "SELECT COALESCE(SUM(json_extract(totales_json, '$.kcal')), 0) AS total FROM comidas WHERE chat_id = ? AND fecha_hora LIKE ?"
    )
    .get(chatId, `${fecha}%`);
  return fila.total;
}

// ¿Ya anotó ese tipo de comida (desayuno, almuerzo...) en el día? Lo usan los recordatorios.
export function hayComidaDelTipo(chatId, fecha, tipoComida) {
  const fila = db
    .prepare('SELECT 1 FROM comidas WHERE chat_id = ? AND fecha_hora LIKE ? AND tipo_comida = ? LIMIT 1')
    .get(chatId, `${fecha}%`, tipoComida);
  return fila !== undefined;
}

// Días (YYYY-MM-DD) con al menos una comida anotada. Sirve para la racha.
export function diasConComidas(chatId) {
  return db
    .prepare('SELECT DISTINCT substr(fecha_hora, 1, 10) AS fecha FROM comidas WHERE chat_id = ?')
    .all(chatId)
    .map((fila) => fila.fecha);
}

// Devuelve las comidas del día con sus items, con los JSON ya convertidos a objetos.
export function comidasDelDia(chatId, fecha) {
  const comidas = db
    .prepare('SELECT * FROM comidas WHERE chat_id = ? AND fecha_hora LIKE ? ORDER BY fecha_hora, id')
    .all(chatId, `${fecha}%`);
  const buscarItems = db.prepare('SELECT * FROM comida_items WHERE comida_id = ? ORDER BY id');

  return comidas.map((comida) => ({
    id: comida.id,
    fecha_hora: comida.fecha_hora,
    tipo_comida: comida.tipo_comida,
    foto_path: comida.foto_path,
    confianza: comida.confianza,
    items: buscarItems.all(comida.id).map((item) => ({
      nombre: item.nombre,
      gramos: item.gramos,
      fuente: item.fuente,
      nutrientes: JSON.parse(item.nutrientes_json),
    })),
    totales: JSON.parse(comida.totales_json),
  }));
}
