// Búsqueda de alimentos en USDA FoodData Central y cálculo de nutrientes según los gramos.
import { config } from './config.js';

const URL_USDA = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// Código de nutriente de USDA para cada una de nuestras claves.
// Algunos tienen alternativas porque los alimentos "Foundation" informan
// el mismo dato con otro código que los "SR Legacy" (ej. energía o azúcar).
const CODIGOS_USDA = {
  kcal: [1008, 2047, 2048],
  proteina_g: [1003],
  carbohidratos_g: [1005, 1050],
  grasa_g: [1004, 1085],
  fibra_g: [1079],
  azucar_g: [2000, 1063],
  sodio_mg: [1093],
  calcio_mg: [1087],
  hierro_mg: [1089],
  potasio_mg: [1092],
  vitamina_c_mg: [1162],
  vitamina_d_ug: [1114],
  vitamina_b12_ug: [1178],
};

// Lista de claves de nutrientes; la usa también vision.js para pedirle la estimación a Claude.
export const NUTRIENTES = Object.keys(CODIGOS_USDA);

function redondear(numero, decimales = 1) {
  const factor = 10 ** decimales;
  return Math.round(numero * factor) / factor;
}

// Pide a USDA los primeros resultados de un término para ciertos tipos de datos.
async function pedirAUsda(termino, tiposDeDatos) {
  const respuesta = await fetch(`${URL_USDA}?api_key=${config.usdaApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: termino, dataType: tiposDeDatos, pageSize: 10 }),
  });
  if (!respuesta.ok) {
    throw new Error(`USDA respondió ${respuesta.status} buscando "${termino}"`);
  }
  const datos = await respuesta.json();
  return datos.foods ?? [];
}

// "Chicken, thigh, cooked" → ["chicken", "thigh", "cooked"]
function palabras(texto) {
  return texto.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

// La comparación es por palabra exacta a propósito: así "thigh" (muslo)
// no coincide con "Chicken, skin (drumsticks and thighs)" (solo la piel).
function contieneTodasLasPalabras(descripcion, termino) {
  const palabrasDescripcion = palabras(descripcion);
  return palabras(termino).every((palabra) => palabrasDescripcion.includes(palabra));
}

// Busca un término en USDA y devuelve el alimento más adecuado, o null si no hay nada.
async function buscarEnUsda(termino) {
  // Primero probamos solo con los tipos más confiables (Foundation y SR Legacy).
  // Si no aparece nada, probamos con platos preparados (Survey) antes de rendirnos.
  const intentos = [['Foundation', 'SR Legacy'], ['Survey (FNDDS)']];

  // USDA ordena por parecido de texto y el primero no siempre es el correcto
  // (ej: "chicken, thigh" devolvía primero la piel). Por eso nos quedamos con
  // el primero que tenga todas las palabras del término. Si ninguno las tiene,
  // usamos el primer resultado que haya aparecido.
  let primerResultado = null;
  for (const tiposDeDatos of intentos) {
    const alimentos = await pedirAUsda(termino, tiposDeDatos);
    const coincidencia = alimentos.find((alimento) => contieneTodasLasPalabras(alimento.description, termino));
    if (coincidencia) return coincidencia;
    primerResultado ??= alimentos[0] ?? null;
  }
  return primerResultado;
}

// USDA informa los valores cada 100 g. Si un nutriente no figura, lo tomamos como 0.
function valorCada100g(alimentoUsda, codigos) {
  for (const codigo of codigos) {
    const nutriente = alimentoUsda.foodNutrients.find((n) => n.nutrientId === codigo);
    if (nutriente) return nutriente.value;
  }
  return 0;
}

// Calcula un alimento: con USDA si lo encuentra; si no, con la estimación de Claude.
async function calcularItem(item) {
  const alimentoUsda = await buscarEnUsda(item.termino_busqueda);

  if (!alimentoUsda) {
    console.log(`USDA: no encontré "${item.termino_busqueda}", uso la estimación de Claude`);
    const nutrientes = {};
    for (const clave of NUTRIENTES) {
      nutrientes[clave] = redondear(item.nutrientes_estimados[clave]);
    }
    return { nombre: item.nombre, gramos: item.gramos, fuente: 'estimado_ia', nutrientes };
  }

  console.log(`USDA: "${item.termino_busqueda}" → "${alimentoUsda.description}" (${alimentoUsda.dataType})`);
  const factor = item.gramos / 100;
  const nutrientes = {};
  for (const [clave, codigos] of Object.entries(CODIGOS_USDA)) {
    nutrientes[clave] = redondear(valorCada100g(alimentoUsda, codigos) * factor);
  }
  return { nombre: item.nombre, gramos: item.gramos, fuente: 'usda', nutrientes };
}

// Suma una lista de objetos de nutrientes y devuelve el total.
export function sumarNutrientes(listaDeNutrientes) {
  const total = {};
  for (const clave of NUTRIENTES) {
    const suma = listaDeNutrientes.reduce((acumulado, nutrientes) => acumulado + (nutrientes[clave] ?? 0), 0);
    total[clave] = redondear(suma);
  }
  return total;
}

// Multiplica gramos y nutrientes de todos los alimentos de una comida.
// Lo usan los botones "Era menos" (factor 0.8) y "Era más" (factor 1.25).
export function escalarComida(comida, factor) {
  const items = comida.items.map((item) => {
    const nutrientes = {};
    for (const clave of NUTRIENTES) {
      nutrientes[clave] = redondear((item.nutrientes[clave] ?? 0) * factor);
    }
    return { ...item, gramos: redondear(item.gramos * factor), nutrientes };
  });
  return { items, totales: sumarNutrientes(items.map((item) => item.nutrientes)) };
}

// Recibe los items que devolvió Claude y arma la comida completa:
// { items, totales, confianza }, lista para guardar en la base.
export async function calcularComida(itemsDeClaude) {
  // Buscamos todos los alimentos en USDA en paralelo para no hacerla esperar de más.
  const items = await Promise.all(itemsDeClaude.map(calcularItem));
  const totales = sumarNutrientes(items.map((item) => item.nutrientes));

  // La confianza de la comida es el promedio de la confianza de cada alimento.
  const sumaConfianza = itemsDeClaude.reduce((acumulado, item) => acumulado + item.confianza, 0);
  const confianza = redondear(sumaConfianza / itemsDeClaude.length, 2);

  return { items, totales, confianza };
}
