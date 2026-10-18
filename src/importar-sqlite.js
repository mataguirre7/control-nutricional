// Herramienta de una sola vez: pasa a Postgres los datos exportados de la base SQLite vieja.
// Uso: npm run importar-sqlite -- data/exportacion-sqlite.json
//
// El JSON lo genera el comando de exportación del README (sección "Migración desde SQLite").
// Conserva los ids originales, así los botones de mensajes viejos siguen apuntando a la comida
// correcta. Se puede correr más de una vez: lo que ya está importado se saltea.
import fs from 'node:fs';
import { verificarVariables } from './config.js';
import { prepararBase, cerrarBase, enTransaccion, ajustarNumeracion } from './db.js';

const ruta = process.argv[2];
if (!ruta) {
  console.error('Uso: npm run importar-sqlite -- data/exportacion-sqlite.json');
  process.exit(1);
}
verificarVariables(['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']);

const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
await prepararBase();

const importados = await enTransaccion(async (cliente) => {
  const cuenta = { usuarios: 0, comidas: 0, comida_items: 0, agua: 0, peso: 0 };

  for (const u of datos.usuarios ?? []) {
    const r = await cliente.query(
      `INSERT INTO usuarios (chat_id, nombre, peso_objetivo, meta_kcal, meta_agua_ml)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chat_id) DO NOTHING`,
      [u.chat_id, u.nombre, u.peso_objetivo, u.meta_kcal, u.meta_agua_ml]
    );
    cuenta.usuarios += r.rowCount;
  }

  // Los registros sin chat_id son de cuando el bot era de una sola persona: no tienen dueño y no se pasan.
  const idsDeComidas = new Set();
  for (const c of (datos.comidas ?? []).filter((c) => c.chat_id)) {
    const r = await cliente.query(
      `INSERT INTO comidas (id, chat_id, fecha_hora, tipo_comida, foto_path, totales_json, confianza)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.chat_id, c.fecha_hora, c.tipo_comida, c.foto_path, c.totales_json, c.confianza]
    );
    cuenta.comidas += r.rowCount;
    idsDeComidas.add(c.id);
  }

  for (const i of (datos.comida_items ?? []).filter((i) => idsDeComidas.has(i.comida_id))) {
    const r = await cliente.query(
      `INSERT INTO comida_items (id, comida_id, nombre, gramos, nutrientes_json, fuente)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [i.id, i.comida_id, i.nombre, i.gramos, i.nutrientes_json, i.fuente]
    );
    cuenta.comida_items += r.rowCount;
  }

  for (const tabla of ['agua', 'peso']) {
    const columna = tabla === 'agua' ? 'ml' : 'kg';
    for (const fila of (datos[tabla] ?? []).filter((f) => f.chat_id)) {
      const r = await cliente.query(
        `INSERT INTO ${tabla} (id, chat_id, fecha_hora, ${columna}) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [fila.id, fila.chat_id, fila.fecha_hora, fila[columna]]
      );
      cuenta[tabla] += r.rowCount;
    }
  }

  await ajustarNumeracion(cliente);
  return cuenta;
});

console.log('Importado:', Object.entries(importados).map(([tabla, n]) => `${tabla} ${n}`).join(' · '));
await cerrarBase();
