# Control nutricional

Sistema simple para seguir comidas, agua y peso de **una familia** (las personas que configures) usando Telegram, pensado para acompañar a cada una a cuidarse y bajar de peso, no solo para registrar. Cada persona tiene sus propios datos y metas.

- Cada persona usa solo el bot, desde su propio chat. Manda fotos de la comida o de la balanza, cuenta en palabras lo que comió, escribe su peso, toca **"+1 vaso 💧"** o hace preguntas ("¿qué puedo cenar?").
- Claude entiende la foto o el texto. Si es comida, identifica los alimentos, estima los gramos y le deja un consejo amable. Si es una balanza, lee el peso.
- Los nutrientes se calculan con la base de **USDA FoodData Central**.
- Tiene barras de progreso, rachas, logros, tendencia semanal de peso, un resumen cada noche y un resumen semanal (que también puede llegarle a la familia).
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

El bot solo le responde a los chats que configures, así que necesitás el número de chat de cada persona. Repetí esto para cada una:

1. Desde el Telegram de esa persona, abrí el bot que creaste y mandale cualquier mensaje (ej: `hola`).
2. En el navegador, entrá a la siguiente dirección, reemplazando `<TOKEN>` por el token del paso 1:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. En la respuesta, buscá `"chat":{"id":123456789,"first_name":"..."}`. Ese número es su chat_id; el `first_name` te dice de quién es. Van todos juntos en `TELEGRAM_CHAT_IDS`, separados por coma.

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
| `TELEGRAM_CHAT_IDS` | chat_id de cada persona, separados por coma (paso 2) |
| `ANTHROPIC_API_KEY` | Key de Anthropic (paso 4) |
| `USDA_API_KEY` | Key de USDA (paso 3) |
| `API_KEY` | Una clave que inventás vos para proteger la API REST |

Las opcionales ya tienen valores por defecto:

| Variable | Default | Qué es |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Modelo de Claude que analiza las fotos |
| `PORT` | `3000` | Puerto de la API |
| `VASO_ML` | `250` | Mililitros que suma cada "+1 vaso" |
| `RESUMEN_DIARIO` | `22:30` | Hora del resumen de cada noche |
| `RESUMEN_SEMANAL` | `20:00` | Hora del resumen semanal (los domingos) |
| `RECORDATORIO_DESAYUNO` | `08:30` | Horario del recordatorio |
| `RECORDATORIO_ALMUERZO` | `13:00` | Horario del recordatorio |
| `RECORDATORIO_MERIENDA` | `17:30` | Horario del recordatorio |
| `RECORDATORIO_CENA` | `21:00` | Horario del recordatorio |
| `RECORDATORIO_AGUA` | `10:00,12:00,15:00,17:00,19:00` | Horarios del recordatorio de agua |
| `RECORDATORIO_PESO` | `08:00` | Horario del recordatorio |

Los horarios van en formato `HH:MM`, en hora argentina. Todos aceptan varios valores separados por coma.

Las **metas** (peso, calorías y agua) no van en el `.env`: cada persona las configura escribiéndole al bot, como en una charla.

| Le escribe… | Qué pasa |
|---|---|
| "quiero llegar a 85 kilos" | Meta de peso; el bot muestra el % del camino recorrido |
| "quiero comer 1600 calorías por día" | Meta de calorías; se muestra con barra de progreso |
| "quiero tomar 2 litros de agua por día" | Meta de agua (si no la cambia, son 2 L) |
| "sacá mi meta de calorías" | Saca esa meta |

Para quien prefiera comandos, también están `/metas`, `/meta_peso 85`, `/meta_kcal 1600`, `/meta_agua 2` y `/meta_peso 0` (saca la meta).

> Conviene que las metas de peso y calorías las defina su médico o nutricionista.
>
> El bot no puede escribirle primero a nadie: cada persona tiene que mandarle `/start` una vez para empezar a recibir recordatorios y resúmenes.

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

## Cómo se usa

No hace falta saber comandos. Abajo del chat quedan siempre 4 botones grandes, y todo lo demás se hace mandando fotos o escribiendo normal.

```
[ 💧 Tomé un vaso ] [ 📊 ¿Cómo voy? ]
[ 🎯 Mis metas    ] [ ❓ Ayuda      ]
```

| La persona hace… | El bot… |
|---|---|
| Manda una foto de comida | La anota y responde con descripción, ingredientes, macros, un consejo amable 💡, la barra de calorías del día y la racha |
| Cuenta lo que comió ("comí 2 empanadas de carne") | Lo mismo que con la foto |
| Toca **➖ Era menos** / **➕ Era más** | Corrige la porción (×0,8 / ×1,25; uno deshace al otro) |
| Toca **🗑️ Borrar** | Pide confirmación y borra la comida |
| Manda una foto de la balanza, o escribe `72.5` | Anota el peso y responde con el avance: desde el inicio, % hacia la meta, promedio semanal, cambio desde la vez anterior y logros 🏅 |
| Toca **💧 Tomé un vaso** (o **+1 vaso** en los recordatorios), o escribe "tomé 2 vasos" | Suma agua y muestra la barra; festeja cuando cumple la meta del día |
| Toca **📊 ¿Cómo voy?** | Le muestra cómo va el día |
| Toca **🎯 Mis metas**, o escribe "quiero llegar a 85 kilos" | Muestra o cambia sus metas |
| Toca **❓ Ayuda** | Le recuerda todo lo que puede mandar |
| Pregunta algo ("¿qué puedo cenar?") | Claude le responde usando lo que ya comió y sus metas |

El tipo de comida (desayuno, almuerzo, merienda o cena) se deduce por la hora. Los rangos están en `RANGOS_COMIDAS`, dentro de [src/config.js](src/config.js).

### Lo que el bot hace solo

- **Recordatorios que no molestan:** si ya anotó el almuerzo, no le recuerda el almuerzo; si ya cumplió el agua, se cortan los de agua; si ya se pesó, no le recuerda el peso.
- **Resumen de cada noche** (`RESUMEN_DIARIO`): comidas, calorías, agua, racha y una sugerencia de Claude para mañana.
- **Resumen semanal** (domingos, `RESUMEN_SEMANAL`): días anotados, promedio de calorías, días con el agua cumplida, tendencia de peso y racha. Cada persona recibe el suyo y una copia del de los demás ("Así le fue a Marta esta semana"), para acompañarse entre todos. Quien no anotó nada en la semana no tiene resumen.

Los horarios son los mismos para todos, pero cada persona recibe lo suyo, con sus propios datos y metas.
- **Logros:** rachas de 3, 7, 14, 21, 30… días anotando o cumpliendo el agua; el primer kilo, cada 5 kg y el 5% y 10% del peso inicial.

### Costo

Cada foto, texto libre o pregunta es una llamada a Claude (unos centavos de dólar). Los números de peso, los botones y los comandos no usan Claude. El consejo de la noche es una llamada más por día.

---

## API REST

Todas las rutas piden el header `x-api-key` con el valor de `API_KEY`.

`/api/dia` y `/api/rango` aceptan `?chat_id=…` para traer a una sola persona. Sin `chat_id` devuelven a todas, agrupadas en `usuarios`. Un `chat_id` que no está en `TELEGRAM_CHAT_IDS` devuelve 404.

### Personas

```bash
curl -H "x-api-key: TU_API_KEY" http://localhost:3000/api/usuarios
```

```json
[
  { "chat_id": "111111111", "nombre": "Marta", "registrado": true, "peso_objetivo": 85, "meta_kcal": 1600, "meta_agua_ml": 2000 },
  { "chat_id": "333333333", "nombre": null, "registrado": false, "peso_objetivo": null, "meta_kcal": null, "meta_agua_ml": 2000 }
]
```

`registrado: false` significa que esa persona todavía no le escribió al bot.

### Un día

```bash
curl -H "x-api-key: TU_API_KEY" "http://localhost:3000/api/dia/2026-10-16?chat_id=111111111"
```

```json
{
  "chat_id": "111111111",
  "nombre": "Marta",
  "fecha": "2026-10-16",
  "comidas": [
    {
      "id": 12,
      "fecha_hora": "2026-10-16 13:05:00",
      "tipo_comida": "almuerzo",
      "foto_path": "data/fotos/111111111_2026-10-16_130500_345.jpg",
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

Sin `chat_id` (`/api/dia/2026-10-16`):

```json
{ "fecha": "2026-10-16", "usuarios": [ { "chat_id": "111111111", "nombre": "Marta", "...": "mismo formato de arriba" } ] }
```

### Un rango de días

```bash
curl -H "x-api-key: TU_API_KEY" "http://localhost:3000/api/rango?desde=2026-10-01&hasta=2026-10-16&chat_id=111111111"
```

```json
{ "desde": "2026-10-01", "hasta": "2026-10-16", "chat_id": "111111111", "nombre": "Marta", "dias": [ { "...": "mismo formato que /api/dia" } ] }
```

Sin `chat_id`: `{ "desde", "hasta", "usuarios": [ { "chat_id", "nombre", "dias": [...] } ] }`.

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
  bot.js          # handlers de Telegram (fotos, textos, botones, comandos)
  vision.js       # llamadas a Claude: analizar fotos/textos (JSON estricto) y consejo del día
  nutrition.js    # búsqueda en USDA, cálculo por gramos y corrección de porciones
  progreso.js     # barras, rachas, logros, tendencia de peso, resúmenes y mensajes
  reminders.js    # recordatorios inteligentes y resúmenes con node-cron
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

---

## Producción en un VPS (Linux)

1. Instalar Docker: `curl -fsSL https://get.docker.com | sudo sh`
2. Clonar el repo y copiar el `.env` (no está en git): `scp .env usuario@IP:~/control-nutricional/`
3. **Apagar cualquier otra copia del bot** (por ejemplo en tu PC): con el mismo token, solo puede correr una a la vez.
4. `docker compose up -d --build`

Actualizar después de un cambio: `git pull && docker compose up -d --build`.

La API solo escucha dentro del servidor (`127.0.0.1`). Para consultarla desde tu compu, abrí un túnel SSH y usala como si fuera local:

```bash
ssh -N -L 3000:127.0.0.1:3000 usuario@IP
curl -H "x-api-key: TU_API_KEY" http://localhost:3000/api/usuarios
```
