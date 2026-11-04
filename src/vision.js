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

// Cómo estimar porciones y nutrientes. Las usan el análisis de cada mensaje y la revisión
// de comidas ya guardadas, para que las dos calculen igual.
const REGLAS_DE_ALIMENTOS = `- Es comida casera argentina. Pensá en preparaciones típicas de una casa argentina (milanesas, tartas, guisos, empanadas, pastas, ensaladas, etc.).
- Primero estimá la porción real de cada alimento, según lo que se ve o lo que cuenta (unidades y tamaño: "2 canelones medianos"). Recién después calculá sus nutrientes. Nunca ajustes los gramos para llegar a un total de calorías.
- En una foto, usá el plato y los cubiertos como referencia de tamaño. Si no hay cantidades, usá porciones caseras estándar (ej: un canelón mediano con su relleno ≈ 120 g, una empanada ≈ 90 g, una milanesa mediana ≈ 150 g, un plato de pastas ≈ 250 g cocidas).
- Listá cada componente una sola vez y sin superponer pesos. Un plato armado (canelones, milanesa, tarta, empanadas, lasaña, guiso) va como UN alimento, con su masa, su relleno y el aceite o la manteca de su cocción ya incluidos en sus valores. Lo que se ve encima o al costado (salsa, queso gratinado, aderezo, guarnición) va aparte, con sus propios gramos, sin contarlo también dentro del plato.
- Si se ve o se menciona aceite, manteca o aderezo agregado aparte (por ejemplo, en la ensalada), va como un alimento más: suma muchas calorías.
- "termino_busqueda": en inglés, simple y genérico, como figuraría en la base de datos USDA (ej: "beef, ground, cooked", "rice, white, cooked", "lettuce, raw"). Para un plato armado, el nombre del plato en inglés (ej: "cannelloni, ricotta, spinach").
- "nutrientes_estimados": los de ESOS gramos, a partir de valores realistas cada 100 g del alimento tal como se come (cocido). Por ejemplo: canelones de ricota y espinaca ≈ 150 a 200 kcal cada 100 g; salsa de tomate casera ≈ 40 a 70; queso gratinado ≈ 300 a 400; arroz blanco cocido ≈ 130. Se usan si USDA no tiene ese alimento.
- Las calorías tienen que cuadrar con los macronutrientes: kcal ≈ 4 × proteína + 4 × carbohidratos + 9 × grasa (más 7 kcal por gramo de alcohol en bebidas alcohólicas).
- Para cada alimento dá una confianza de 0 a 1 sobre qué tan seguro estás del alimento y de los gramos.`;

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
${REGLAS_DE_ALIMENTOS}
- En "descripcion" escribí una sola frase corta y simple de lo que comió (ej: "Arroz amarillo con pollo, morrón y perejil").
- En "supuestos" escribí una frase corta con lo que tuviste que suponer (tamaño de las porciones, ingredientes que no se ven, cómo está cocinado). Dejalo vacío si no supusiste nada importante.
- Si la persona menciona un total de calorías (ej: "anotá 460 kcal"), no lo uses: estimá igual con tus propios valores y, si tu resultado es muy distinto, decilo en "supuestos".
- "corrige_comida_anterior" va en true solo si dice que la última comida que anotó estaba mal y te la vuelve a describir (ej: "corregí mi cena: fueron 2 canelones medianos"). En ese caso poné en "items" la comida COMPLETA corregida, no solo lo que cambia.
- En "consejo" escribí una sola frase corta, amable y concreta para sumar algo bueno (ej: "¡Buen plato! Si la próxima le sumás ensalada, te llena más con pocas calorías 🥗"). Tené en cuenta el contexto del día.

"respuesta" se usa en estos casos:
- Si pregunta o pide algo sobre comida, nutrición, recetas o su progreso (ej: "¿qué puedo cenar?"): contestá en 2 a 4 oraciones cortas y prácticas, usando el contexto del día (lo que ya comió, calorías y agua que lleva, sus metas). Sugerí comidas caseras argentinas simples.
- Si el mensaje no trae ningún dato ni pregunta (saludos, agradecimientos, fotos que no son comida ni balanza): contestá breve y amable, y recordale que puede mandarte fotos de lo que come o de la balanza, contarte qué comió o hacerte preguntas.
- Si trae datos y no pregunta nada, dejala vacía: el bot ya confirma cada dato.`;

const NUMERO_O_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };

// Un alimento como lo devuelve Claude. Lo comparten el análisis y la revisión de comidas.
const LISTA_DE_ALIMENTOS = {
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
};

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
    supuestos: { type: 'string' },
    corrige_comida_anterior: { type: 'boolean' },
    items: LISTA_DE_ALIMENTOS,
  },
  required: ['descripcion', 'consejo', 'respuesta', 'kg', 'agua_ml', 'metas', 'datos', 'calcular_tmb', 'ejercicios', 'supuestos', 'corrige_comida_anterior', 'items'],
  additionalProperties: false,
};

// Para revisar comidas ya guardadas: solo los alimentos, con los mismos campos.
const ESQUEMA_REVISION = {
  type: 'object',
  properties: { items: LISTA_DE_ALIMENTOS },
  required: ['items'],
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
// Devuelve { descripcion, consejo, respuesta, kg, agua_ml, metas, datos, calcular_tmb, ejercicios,
// supuestos, corrige_comida_anterior, items }.
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

// Vuelve a estimar alimentos ya guardados, manteniendo sus gramos. Lo usa la revisión de comidas.
// alimentos: [{ nombre, gramos }]. Devuelve la lista en el mismo orden, con término y nutrientes,
// o null si Claude no devolvió exactamente los mismos alimentos.
export async function reestimarAlimentos(alimentos) {
  const lista = alimentos.map((alimento, i) => `${i + 1}. ${alimento.nombre}: ${alimento.gramos} g`).join('\n');
  const respuesta = await crearCliente().messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system: `Sos un asistente de nutrición. Vas a estimar los nutrientes de alimentos que una persona ya anotó.\n\n${REGLAS_DE_ALIMENTOS}`,
    messages: [
      {
        role: 'user',
        content: `Estos alimentos ya están anotados con sus gramos. Devolvé exactamente los mismos, en el mismo orden, con el mismo nombre y los MISMOS gramos (no los cambies), y completá el resto:\n\n${lista}`,
      },
    ],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA_REVISION } },
  });

  const { items } = JSON.parse(textoDeRespuesta(respuesta));
  if (items.length !== alimentos.length) return null;
  // Los gramos se fuerzan a los guardados: la revisión corrige nutrientes, no porciones.
  return items.map((item, i) => ({ ...item, nombre: alimentos[i].nombre, gramos: alimentos[i].gramos }));
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
