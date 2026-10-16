# Control nutricional

Sistema simple para seguir comidas, agua y peso de **una sola persona** usando Telegram.

- Ella usa solo el bot. Manda fotos de la comida o de la balanza, escribe su peso o toca **"+1 vaso 💧"**.
- Claude mira la foto. Si es comida, identifica los alimentos y estima los gramos. Si es una balanza, lee el peso.
- Los nutrientes se calculan con la base de **USDA FoodData Central**.
- Vos consultás todo con una API REST.

## Requisitos

- Una cuenta de Telegram.
- Docker con Docker Compose, para dejarlo corriendo.
- Node.js 24 o superior, solo si querés correrlo sin Docker o usar `npm run probar-foto`.

---

## Puesta en marcha paso a paso

### 1. Crear el bot con BotFather

1. En Telegram, buscá **@BotFather** y abrí el chat.
2. Mandale `/newbot`.
3. Elegí un nombre (ej: `Nutri de Mamá`) y un usuario que termine en `bot` (ej: `nutri_mama_bot`).
4. BotFather te da un **token** parecido a `123456789:AAH...`. Guardalo: es tu `TELEGRAM_BOT_TOKEN`.

### 2. Obtener el chat_id

El bot solo le responde a un chat, así que necesitás el número de chat de tu mamá.

1. Desde el Telegram de tu mamá, abrí el bot que creaste y mandale cualquier mensaje (ej: `hola`).
2. En el navegador, entrá a la siguiente dirección, reemplazando `<TOKEN>` por el token del paso 1:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. En la respuesta, buscá `"chat":{"id":123456789,...}`. Ese número es el `TELEGRAM_CHAT_ID`.

> Si la respuesta sale vacía (`"result":[]`), mandale otro mensaje al bot y recargá la página.
>
> Otra forma: con el sistema ya levantado, cualquier mensaje de un chat no autorizado aparece en los logs como `Mensaje ignorado de chat_id ...`.

### 3. API key de USDA (gratis)

1. Entrá a https://fdc.nal.usda.gov/api-key-signup
2. Completá nombre y email.
3. La key te llega por email. Es tu `USDA_API_KEY`.

> Para una prueba rápida podés usar `DEMO_KEY`, pero tiene un límite muy bajo de pedidos.

### 4. API key de Anthropic (Claude)

1. Entrá a https://platform.claude.com y creá una cuenta (o iniciá sesión).
2. Cargá crédito en **Billing**. La API se paga por uso.
3. En **API Keys**, creá una key nueva. Empieza con `sk-ant-` y es tu `ANTHROPIC_API_KEY`.

### 5. Configurar el `.env`

```bash
cp .env.example .env
```

Abrí `.env` y completá las cinco variables obligatorias:

| Variable | Qué es |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token de BotFather (paso 1) |
| `TELEGRAM_CHAT_ID` | chat_id de tu mamá (paso 2) |
| `ANTHROPIC_API_KEY` | Key de Anthropic (paso 4) |
| `USDA_API_KEY` | Key de USDA (paso 3) |
| `API_KEY` | Una clave que inventás vos para proteger la API REST |

Las opcionales ya tienen valores por defecto:

| Variable | Default | Qué es |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Modelo de Claude que analiza las fotos |
| `PORT` | `3000` | Puerto de la API |
| `VASO_ML` | `250` | Mililitros que suma cada "+1 vaso" |
| `PESO_OBJETIVO` | (vacío) | Peso meta en kg; si está, el bot muestra el % del camino recorrido |
| `RECORDATORIO_DESAYUNO` | `08:30` | Horario del recordatorio |
| `RECORDATORIO_ALMUERZO` | `13:00` | Horario del recordatorio |
| `RECORDATORIO_MERIENDA` | `17:30` | Horario del recordatorio |
| `RECORDATORIO_CENA` | `21:00` | Horario del recordatorio |
| `RECORDATORIO_AGUA` | `10:00,12:00,15:00,17:00,19:00` | Horarios del recordatorio de agua |
| `RECORDATORIO_PESO` | `08:00` | Horario del recordatorio |

Los horarios van en formato `HH:MM`, en hora argentina. Todos aceptan varios valores separados por coma.

### 6. Levantar todo

```bash
docker compose up -d
```

Para ver los logs:

```bash
docker compose logs -f
```

Tendrías que ver `Bot @tu_bot escuchando mensajes` y `API escuchando en el puerto 3000`.

Si cambiás el `.env`, reiniciá con `docker compose up -d`. Si cambiás el código, agregá `--build`:

```bash
docker compose up -d --build
```

---

## Cómo lo usa ella

| Ella hace… | El bot… |
|---|---|
| Manda una foto de comida | La anota y responde con una descripción, los ingredientes, los macros y las kcal acumuladas del día |
| Manda una foto de la balanza | Lee el peso, lo anota y responde con el avance: cambio desde el primer peso, % hacia la meta (`PESO_OBJETIVO`) y diferencia con la vez anterior |
| Escribe `72.5` o `72,5` | Lo mismo que la foto de la balanza |
| Toca **+1 vaso 💧** | Suma un vaso y responde `Llevás 1,25 L de agua hoy 💧` |
| Escribe `/agua` | Le muestra el total del día y el botón |
| Manda otra cosa | Le explica qué puede mandar |

El tipo de comida (desayuno, almuerzo, merienda o cena) se deduce por la hora de la foto. Los rangos están en `RANGOS_COMIDAS`, dentro de [src/config.js](src/config.js).

---

## API REST

Todas las rutas piden el header `x-api-key` con el valor de `API_KEY`.

### Un día

```bash
curl -H "x-api-key: TU_API_KEY" http://localhost:3000/api/dia/2026-10-16
```

```json
{
  "fecha": "2026-10-16",
  "comidas": [
    {
      "id": 12,
      "fecha_hora": "2026-10-16 13:05:00",
      "tipo_comida": "almuerzo",
      "foto_path": "data/fotos/2026-10-16_130500_345.jpg",
      "confianza": 0.78,
      "items": [
        {
          "nombre": "milanesa de carne",
          "gramos": 150,
          "fuente": "usda",
          "nutrientes": {
            "kcal": 380, "proteina_g": 28.1, "carbohidratos_g": 14.2, "grasa_g": 23,
            "fibra_g": 0.8, "azucar_g": 1.1, "sodio_mg": 520, "calcio_mg": 40, "hierro_mg": 3.1,
            "potasio_mg": 390, "vitamina_c_mg": 0, "vitamina_d_ug": 0.2, "vitamina_b12_ug": 2.4
          }
        }
      ],
      "totales": { "kcal": 620, "proteina_g": 35, "...": "mismas 13 claves" }
    }
  ],
  "agua_ml": 1250,
  "peso": { "kg": 72.5, "fecha_hora": "2026-10-16 08:10:00" },
  "totales_dia": { "kcal": 1480, "...": "mismas 13 claves" }
}
```

- `fuente` vale `"usda"` si el alimento se encontró en USDA, o `"estimado_ia"` si se usó la estimación de Claude.
- `peso` es el último registro del día, o `null` si ese día no se pesó.

### Un rango de días

```bash
curl -H "x-api-key: TU_API_KEY" "http://localhost:3000/api/rango?desde=2026-10-01&hasta=2026-10-16"
```

```json
{ "desde": "2026-10-01", "hasta": "2026-10-16", "dias": [ { "...": "mismo formato que /api/dia" } ] }
```

Incluye todos los días del rango, aunque no tengan registros. Admite como máximo 366 días.

---

## Probar una foto sin Telegram

Necesitás Node.js instalado y el `.env` con `ANTHROPIC_API_KEY` y `USDA_API_KEY`.

```bash
npm install
npm run probar-foto -- ruta/a/foto.jpg
```

El comando imprime lo que devolvió Claude (`analisis_claude`) y, si la foto es de comida, el cálculo final (`comida`). No guarda nada en la base de datos.

---

## Cómo está armado

```
src/
  index.js        # arranca bot, API y recordatorios
  config.js       # lee el .env y valida las variables
  db.js           # tablas SQLite y funciones de lectura/escritura
  bot.js          # handlers de Telegram
  vision.js       # llamada a Claude con la foto (respuesta en JSON estricto)
  nutrition.js    # búsqueda en USDA y cálculo por gramos
  reminders.js    # recordatorios con node-cron
  api.js          # endpoints de Express
  probar-foto.js  # script para probar una foto desde la consola
data/             # nutricion.db y fotos/ (no se sube a git)
```

Así se procesa una foto de comida:

1. [bot.js](src/bot.js) descarga la foto de Telegram y la guarda en `data/fotos/`.
2. [vision.js](src/vision.js) se la manda a Claude, que devuelve `tipo`, `kg` e `items`. Cada item trae nombre, término en inglés, gramos, confianza y nutrientes estimados.
3. [nutrition.js](src/nutrition.js) busca cada item en USDA. Primero prueba con los tipos *Foundation* y *SR Legacy*. Si no encuentra nada, prueba con *Survey (FNDDS)*. Toma el primer resultado y escala los valores, que USDA da cada 100 g, a los gramos estimados. Si ninguna búsqueda da resultado, usa la estimación de Claude.
4. [db.js](src/db.js) guarda la comida y sus items.

### Backup

Todo está en la carpeta `data/`. Para hacer un backup alcanza con copiarla, idealmente con el sistema parado (`docker compose stop`).
