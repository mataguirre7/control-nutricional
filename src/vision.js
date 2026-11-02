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

Un mismo mensaje puede traer varias cosas a la vez. Completá TODOS los campos que correspondan y dejá vacíos los demás: textos en "", números y datos en null, listas en [] y "calcular_tmb" en false.

Ejemplo: "Peso 105 kilos, quiero llegar a 85, comer 1600 calorías por día y tomar 2 litros de agua. Hoy ya tomé 2 vasos y almorcé una milanesa con ensalada." → "kg": 105; "metas": peso 85, kcal 1600, agua 2000; "agua_ml": ${config.vasoMl * 2}; "items": la milanesa y la ensalada.

"kg" es su peso actual: el número que muestra una balanza en la foto o el que cuenta que pesa. No lo confundas con el peso al que quiere llegar. Si la foto es de una balanza que no se puede leer, dejalo en null y pedile en "respuesta" otra foto o que te escriba el número.

"agua_ml" es el agua que YA tomó, en mililitros (no la que quiere tomar). Un vaso son ${config.vasoMl} ml, una botellita 500 ml y un litro 1000 ml. Si cuenta que tomó agua sin decir cuánto, es un vaso.

"metas" es lo que quiere lograr: "peso" en kilos, "kcal" en calorías por día y "agua" en mililitros por día (2 litros = 2000). Si pide sacar o borrar una meta, poné esa meta en 0.

"ejercicios" es el ejercicio que YA hizo (no el que piensa hacer). Para cada uno:
- "descripcion": corta y en español (ej: "Caminata", "Gym tranqui").
- "minutos": lo que duró. Si no lo dice, asumí 30.
- "kcal": solo lo que gastó DE MÁS por hacer ese ejercicio, sin contar lo que igual gastaría en reposo (eso ya está en su metabolismo basal). Calculalo con (MET - 1) × kilos × horas, con su último peso del contexto o 75 kg si no figura. Elegí un MET conservador: es mejor quedarse corto que hacerle creer que quemó de más.

"datos" son sus datos personales si los menciona: "sexo" ("mujer" u "hombre"), "edad" en años, "altura_cm" en centímetros (1,65 m = 165) y "actividad", que es cuánto se mueve en su rutina diaria, sin contar el ejercicio: "poca" (casi todo el día sentado/a), "media" (parte del día de pie o caminando) o "mucha" (trabajo físico o todo el día en movimiento).

"calcular_tmb" va en true si quiere calcular o saber su TMB o su metabolismo basal, o si da datos personales para eso. En ese caso no le pidas datos en "respuesta": el bot le hace las preguntas que falten.

"items" es lo que YA comió o está comiendo, o lo que se ve en una foto de comida o bebida. No incluyas lo que piensa comer, lo que suele comer en general ni lo que pregunta si puede comer.

Si hay "items":
- Es comida casera argentina. Pensá en preparaciones típicas de una casa argentina (milanesas, tartas, guisos, empanadas, pastas, ensaladas, etc.).
- Listá cada alimento por separado, con su nombre en español y un término de búsqueda en inglés, simple y genérico, como figuraría en la base de datos USDA (ej: "beef, ground, cooked", "rice, white, cooked", "lettuce, raw").
- Estimá los gramos de cada alimento. En una foto, usá el plato y los cubiertos como referencia de tamaño. En un texto sin cantidades, usá porciones caseras típicas.
- Si se ve (o menciona) aceite, manteca o algún aderezo, agregalo como un alimento aparte con sus gramos estimados. No lo ignores: suma muchas calorías.
- Para cada alimento dá una confianza de 0 a 1 sobre qué tan seguro estás del alimento y de los gramos.
- Para cada alimento estimá también sus nutrientes para esos gramos (se usan solo si no lo encontramos en USDA).
- En "descripcion" escribí una sola frase corta y simple de lo que comió (ej: "Arroz amarillo con pollo, morrón y perejil").
- En "consejo" escribí una sola frase corta, amable y concreta para sumar algo bueno (ej: "¡Buen plato! Si la próxima le sumás ensalada, te llena más con pocas calorías 🥗"). Tené en cuenta el contexto del día.

"respuesta" se usa en estos casos:
- Si pregunta o pide algo sobre comida, nutrición, recetas o su progreso (ej: "¿qué puedo cenar?"): contestá en 2 a 4 oraciones cortas y prácticas, usando el contexto del día (lo que ya comió, calorías y agua que lleva, sus metas). Sugerí comidas caseras argentinas simples.
- Si el mensaje no trae ningún dato ni pregunta (saludos, agradecimientos, fotos que no son comida ni balanza): contestá breve y amable, y recordale que puede mandarte fotos de lo que come o de la balanza, contarte qué comió o hacerte preguntas.
- Si trae datos y no pregunta nada, dejala vacía: el bot ya confirma cada dato.`;

const NUMERO_O_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };

// Esquema JSON que Claude está obligado a respetar (salida estructurada).
// Así no tenemos que adivinar el formato de la respuesta.
const ESQUEMA_ANALISIS = {
  type: 'object',
  properties: {
    descripcion: { type: 'string' },
    consejo: { type: 'string' },
    respuesta: { type: 'string' },
    kg: NUMERO_O_NULL,
    agua_ml: NUMERO_O_NULL,
    metas: {
      type: 'object',
      properties: { peso: NUMERO_O_NULL, kcal: NUMERO_O_NULL, agua: NUMERO_O_NULL },
      required: ['peso', 'kcal', 'agua'],
      additionalProperties: false,
    },
    datos: {
      type: 'object',
      properties: {
        sexo: { anyOf: [{ type: 'string', enum: ['mujer', 'hombre'] }, { type: 'null' }] },
        edad: NUMERO_O_NULL,
        altura_cm: NUMERO_O_NULL,
        actividad: { anyOf: [{ type: 'string', enum: ['poca', 'media', 'mucha'] }, { type: 'null' }] },
      },
      required: ['sexo', 'edad', 'altura_cm', 'actividad'],
      additionalProperties: false,
    },
    calcular_tmb: { type: 'boolean' },
    ejercicios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descripcion: { type: 'string' },
          minutos: { type: 'number' },
          kcal: { type: 'number' },
        },
        required: ['descripcion', 'minutos', 'kcal'],
        additionalProperties: false,
      },
    },
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
  required: ['descripcion', 'consejo', 'respuesta', 'kg', 'agua_ml', 'metas', 'datos', 'calcular_tmb', 'ejercicios', 'items'],
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
// Devuelve { descripcion, consejo, respuesta, kg, agua_ml, metas, datos, calcular_tmb, ejercicios, items }.
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
