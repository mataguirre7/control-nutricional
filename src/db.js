// Base de datos SQLite: creación de tablas y funciones de lectura/escritura.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CARPETA_DATOS, CARPETA_FOTOS, ZONA_HORARIA } from './config.js';

// Crea data/ y data/fotos/ si todavía no existen.
fs.mkdirSync(CARPETA_FOTOS, { recursive: true });

const db = new Database(path.join(CARPETA_DATOS, 'nutricion.db'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS comidas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
    fecha_hora TEXT NOT NULL,
    ml         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peso (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha_hora TEXT NOT NULL,
    kg         REAL NOT NULL
  );
`);

// Las fechas se guardan como texto en hora argentina: "2026-10-16 13:05:00".
// El formato de Suecia (sv-SE) da justo ese formato, y así buscar un día
// es un simple LIKE '2026-10-16%', sin pelear con zonas horarias.
export function ahoraLocal() {
  return new Date().toLocaleString('sv-SE', { timeZone: ZONA_HORARIA });
}

export function hoyLocal() {
  return ahoraLocal().slice(0, 10);
}

export function guardarAgua(ml) {
  db.prepare('INSERT INTO agua (fecha_hora, ml) VALUES (?, ?)').run(ahoraLocal(), ml);
}

export function guardarPeso(kg) {
  db.prepare('INSERT INTO peso (fecha_hora, kg) VALUES (?, ?)').run(ahoraLocal(), kg);
}

// Va en una transacción para que nunca quede una comida guardada sin sus items.
export const guardarComida = db.transaction(({ fechaHora, tipoComida, fotoPath, totales, confianza, items }) => {
  const comida = db
    .prepare(
      `INSERT INTO comidas (fecha_hora, tipo_comida, foto_path, totales_json, confianza)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(fechaHora, tipoComida, fotoPath, JSON.stringify(totales), confianza);

  const insertarItem = db.prepare(
    `INSERT INTO comida_items (comida_id, nombre, gramos, nutrientes_json, fuente)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const item of items) {
    insertarItem.run(comida.lastInsertRowid, item.nombre, item.gramos, JSON.stringify(item.nutrientes), item.fuente);
  }
});

// fecha: "YYYY-MM-DD"
export function aguaDelDia(fecha) {
  const fila = db.prepare('SELECT COALESCE(SUM(ml), 0) AS total FROM agua WHERE fecha_hora LIKE ?').get(`${fecha}%`);
  return fila.total;
}

// Suma las kcal de todas las comidas del día leyendo el campo "kcal" del JSON de totales.
export function kcalDelDia(fecha) {
  const fila = db
    .prepare("SELECT COALESCE(SUM(json_extract(totales_json, '$.kcal')), 0) AS total FROM comidas WHERE fecha_hora LIKE ?")
    .get(`${fecha}%`);
  return fila.total;
}

// Primer peso registrado (el punto de partida para medir el avance), o null si no hay ninguno.
export function primerPeso() {
  const fila = db.prepare('SELECT kg FROM peso ORDER BY fecha_hora, id LIMIT 1').get();
  return fila ? fila.kg : null;
}

// Último peso registrado (de cualquier día), o null si no hay ninguno.
export function ultimoPeso() {
  const fila = db.prepare('SELECT kg FROM peso ORDER BY fecha_hora DESC, id DESC LIMIT 1').get();
  return fila ? fila.kg : null;
}

// Devuelve el último peso del día ({ kg, fecha_hora }) o null si no se pesó.
export function ultimoPesoDelDia(fecha) {
  const fila = db
    .prepare('SELECT kg, fecha_hora FROM peso WHERE fecha_hora LIKE ? ORDER BY fecha_hora DESC, id DESC LIMIT 1')
    .get(`${fecha}%`);
  return fila ?? null;
}

// Devuelve las comidas del día con sus items, con los JSON ya convertidos a objetos.
export function comidasDelDia(fecha) {
  const comidas = db.prepare('SELECT * FROM comidas WHERE fecha_hora LIKE ? ORDER BY fecha_hora, id').all(`${fecha}%`);
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
