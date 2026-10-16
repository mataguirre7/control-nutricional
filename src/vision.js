// Le manda la foto a Claude y devuelve qué es (comida, balanza u otro) con sus datos.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { NUTRIENTES } from './nutrition.js';

const INSTRUCCIONES = `Sos un asistente de nutrición. Vas a recibir una foto que mandó una señora desde su casa, en Argentina.

Primero decidí qué muestra la foto:
- "comida": un plato, comida o bebida que va a consumir.
- "balanza": una balanza mostrando su peso.
- "otro": cualquier otra cosa.

Si es "comida":
- Es comida casera argentina. Pensá en preparaciones típicas de una casa argentina (milanesas, tartas, guisos, empanadas, pastas, ensaladas, etc.).
- Listá cada alimento por separado, con su nombre en español y un término de búsqueda en inglés, simple y genérico, como figuraría en la base de datos USDA (ej: "beef, ground, cooked", "rice, white, cooked", "lettuce, raw").
- Estimá los gramos de cada alimento, usando el plato y los cubiertos como referencia de tamaño.
- Si se ve aceite, manteca o algún aderezo (en la comida, el plato o la fuente), agregalo como un alimento aparte con sus gramos estimados. No lo ignores: suma muchas calorías.
- Para cada alimento dá una confianza de 0 a 1 sobre qué tan seguro estás del alimento y de los gramos.
- Para cada alimento estimá también sus nutrientes para esos gramos (se usan solo si no lo encontramos en USDA).
- En "descripcion" escribí una sola frase corta y simple, en español rioplatense, de lo que se ve en el plato (ej: "Arroz amarillo con pollo, morrón y perejil"). Se la vamos a mostrar a ella tal cual.
- Dejá "kg" en null.

Si es "balanza": poné en "kg" el número que muestra la pantalla y dejá "items" vacío. Si no se puede leer, poné "kg" en null.

Si es "otro": dejá "items" vacío y "kg" en null.

Si no es "comida", dejá "descripcion" como texto vacío.`;

// Esquema JSON que Claude está obligado a respetar (salida estructurada).
// Así no tenemos que adivinar el formato de la respuesta.
const ESQUEMA_RESPUESTA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['comida', 'balanza', 'otro'] },
    descripcion: { type: 'string' },
    kg: { anyOf: [{ type: 'number' }, { type: 'null' }] },
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
  required: ['tipo', 'descripcion', 'kg', 'items'],
  additionalProperties: false,
};

// imagen: Buffer con la foto. tipoMime: "image/jpeg", "image/png", etc.
// Devuelve { tipo, descripcion, kg, items }.
export async function analizarFoto(imagen, tipoMime) {
  // El cliente se crea acá (y no al importar el archivo) para que, si falta
  // la API key, el error aparezca con el mensaje claro de config.js.
  const cliente = new Anthropic({ apiKey: config.anthropicApiKey });

  const respuesta = await cliente.messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system: INSTRUCCIONES,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: tipoMime, data: imagen.toString('base64') } },
          { type: 'text', text: 'Analizá esta foto.' },
        ],
      },
    ],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA_RESPUESTA } },
  });

  // Si Claude se negó o se cortó por largo, el JSON puede venir incompleto.
  if (respuesta.stop_reason !== 'end_turn') {
    throw new Error(`Claude terminó con stop_reason "${respuesta.stop_reason}"`);
  }

  const bloqueTexto = respuesta.content.find((bloque) => bloque.type === 'text');
  return JSON.parse(bloqueTexto.text);
}
