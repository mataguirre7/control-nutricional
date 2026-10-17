// Todo lo que habla con Claude: analizar fotos y textos de ella, y escribir el consejo del día.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { NUTRIENTES } from './nutrition.js';

// Personalidad común a todas las llamadas: el tono importa tanto como los datos.
const PERSONALIDAD = `Sos el asistente de nutrición de una familia argentina. Cada integrante usa un bot de Telegram para anotar lo que come, el agua y su peso, porque quiere cuidarse y llegar a un peso saludable.
Siempre le hablás a una sola persona: la que figura en el contexto. Si sabés su nombre, podés usarlo de vez en cuando.
Hablale con calidez y en español rioplatense (usando "vos"). Nunca la retes, no hables de "pasarse" ni la hagas sentir culpable: siempre en positivo y con algo concreto para sumar.
No des diagnósticos ni dietas extremas; si pregunta algo médico, recomendale consultarlo con su médico.
Escribí en texto plano, sin asteriscos ni ningún formato markdown.`;

const INSTRUCCIONES_ANALISIS = `${PERSONALIDAD}

Vas a recibir el contexto de su día y un mensaje suyo: una foto (a veces con un texto) o solo un texto.

Clasificá el mensaje en "tipo":
- "comida": una foto de comida o bebida, o un texto donde cuenta qué comió o está comiendo (ej: "comí 2 empanadas de carne").
- "balanza": una foto de una balanza, o un texto donde dice cuánto pesa (ej: "hoy me pesé 80,5").
- "agua": cuenta que tomó agua (ej: "tomé 2 vasos de agua", "me tomé una botellita").
- "meta": quiere poner, cambiar o sacar una meta de peso, calorías o agua (ej: "quiero llegar a 85 kilos", "mi meta es comer 1600 calorías").
- "pregunta": una pregunta o pedido sobre comida, nutrición, recetas o su progreso (ej: "¿qué puedo cenar?").
- "otro": cualquier otra cosa (saludos, agradecimientos, fotos que no son comida ni balanza).

Si es "comida":
- Es comida casera argentina. Pensá en preparaciones típicas de una casa argentina (milanesas, tartas, guisos, empanadas, pastas, ensaladas, etc.).
- Listá cada alimento por separado, con su nombre en español y un término de búsqueda en inglés, simple y genérico, como figuraría en la base de datos USDA (ej: "beef, ground, cooked", "rice, white, cooked", "lettuce, raw").
- Estimá los gramos de cada alimento. En una foto, usá el plato y los cubiertos como referencia de tamaño. En un texto sin cantidades, usá porciones caseras típicas.
- Si se ve (o menciona) aceite, manteca o algún aderezo, agregalo como un alimento aparte con sus gramos estimados. No lo ignores: suma muchas calorías.
- Para cada alimento dá una confianza de 0 a 1 sobre qué tan seguro estás del alimento y de los gramos.
- Para cada alimento estimá también sus nutrientes para esos gramos (se usan solo si no lo encontramos en USDA).
- En "descripcion" escribí una sola frase corta y simple de lo que comió (ej: "Arroz amarillo con pollo, morrón y perejil").
- En "consejo" escribí una sola frase corta, amable y concreta para sumar algo bueno (ej: "¡Buen plato! Si la próxima le sumás ensalada, te llena más con pocas calorías 🥗"). Tené en cuenta el contexto del día.

Si es "balanza": poné en "kg" el número que muestra la pantalla o que escribió. Si no se puede leer, poné "kg" en null.

Si es "agua": poné en "agua_ml" el total de mililitros que tomó. Un vaso son ${config.vasoMl} ml, una botellita 500 ml y un litro 1000 ml. Si no dice cuánto, es un vaso.

Si es "meta": en "meta" poné "peso", "kcal" o "agua", y en "meta_valor" el número: kilos para el peso, calorías por día para kcal, y mililitros por día para el agua (2 litros = 2000). Si pide sacar o borrar una meta, poné "meta_valor" en 0.

Si es "pregunta": en "respuesta" contestá en 2 a 4 oraciones cortas y prácticas, usando el contexto del día (lo que ya comió, calorías y agua que lleva, sus metas). Sugerí comidas caseras argentinas simples.

Si es "otro": en "respuesta" contestá breve y amable, y recordale que puede mandarte fotos de lo que come o de la balanza, contarte qué comió o hacerte preguntas.

Los campos que no correspondan al tipo dejalos vacíos: textos en "", números en null, "meta" en "ninguna" e "items" en [].`;

// Esquema JSON que Claude está obligado a respetar (salida estructurada).
// Así no tenemos que adivinar el formato de la respuesta.
const ESQUEMA_ANALISIS = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['comida', 'balanza', 'agua', 'meta', 'pregunta', 'otro'] },
    descripcion: { type: 'string' },
    consejo: { type: 'string' },
    respuesta: { type: 'string' },
    kg: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    agua_ml: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    meta: { type: 'string', enum: ['peso', 'kcal', 'agua', 'ninguna'] },
    meta_valor: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          termino_busqueda: { type: 'string' },
          gramos: { type: 'number' },
          confianza: { type: 'number' },
          nutrientes_estimados: {
            type: 'object',
            properties: Object.fromEntries(NUTRIENTES.map((clave) => [clave, { type: 'number' }])),
            required: NUTRIENTES,
            additionalProperties: false,
          },
        },
        required: ['nombre', 'termino_busqueda', 'gramos', 'confianza', 'nutrientes_estimados'],
        additionalProperties: false,
      },
    },
  },
  required: ['tipo', 'descripcion', 'consejo', 'respuesta', 'kg', 'agua_ml', 'meta', 'meta_valor', 'items'],
  additionalProperties: false,
};

// El cliente se crea en cada llamada (y no al importar el archivo) para que,
// si falta la API key, el error aparezca con el mensaje claro de config.js.
function crearCliente() {
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

// Si Claude se negó o se cortó por largo, la respuesta puede venir incompleta.
function textoDeRespuesta(respuesta) {
  if (respuesta.stop_reason !== 'end_turn') {
    throw new Error(`Claude terminó con stop_reason "${respuesta.stop_reason}"`);
  }
  return respuesta.content.find((bloque) => bloque.type === 'text').text;
}

// contenido: los bloques del mensaje (imagen y/o texto). Devuelve el análisis ya parseado.
async function analizar(contenido) {
  const respuesta = await crearCliente().messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system: INSTRUCCIONES_ANALISIS,
    messages: [{ role: 'user', content: contenido }],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA_ANALISIS } },
  });
  return JSON.parse(textoDeRespuesta(respuesta));
}

// imagen: Buffer con la foto. tipoMime: "image/jpeg", "image/png", etc.
// textoAdjunto: el texto que mandó con la foto (puede ser vacío).
// Devuelve { tipo, descripcion, consejo, respuesta, kg, agua_ml, meta, meta_valor, items }.
export function analizarFoto(imagen, tipoMime, contextoDelDia, textoAdjunto = '') {
  return analizar([
    { type: 'image', source: { type: 'base64', media_type: tipoMime, data: imagen.toString('base64') } },
    { type: 'text', text: `Contexto del día:\n${contextoDelDia}\n\nTexto que mandó con la foto: ${textoAdjunto || '(ninguno)'}` },
  ]);
}

// Igual que analizarFoto, pero para un mensaje de texto (ej: "comí 2 empanadas").
export function analizarTexto(texto, contextoDelDia) {
  return analizar([{ type: 'text', text: `Contexto del día:\n${contextoDelDia}\n\nSu mensaje: ${texto}` }]);
}

// Una sola sugerencia para mañana, a partir de cómo le fue hoy. Se usa en el resumen de la noche.
export async function escribirConsejoParaManana(contextoDelDia) {
  const respuesta = await crearCliente().messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system: PERSONALIDAD,
    messages: [
      {
        role: 'user',
        content: `Así fue su día:\n${contextoDelDia}\n\nEscribí UNA sola sugerencia concreta y amable para mañana, de no más de 25 palabras, con un emoji al final. Respondé solo con la sugerencia.`,
      },
    ],
  });
  return textoDeRespuesta(respuesta).trim();
}
