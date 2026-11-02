// Cálculos de progreso (barras, rachas, logros, tendencia de peso) y armado de los
// mensajes que ve cada persona. Todo en texto plano, sin formato, para que se lea simple.
//
// Casi todas las funciones reciben "usuario": { chatId, nombre, pesoObjetivo, metaKcal, metaAguaMl }
// (lo arma obtenerUsuario en db.js), porque cada persona tiene sus propios datos y metas.
// Las que leen la base son async; las de formato y cálculo puro, no.
import { config } from './config.js';
import {
  sumarDias,
  obtenerUsuario,
  aguaDelDia,
  diasConMetaDeAgua,
  kcalDelDia,
  diasConComidas,
  comidasDelDia,
  ultimoPeso,
  ultimoPesoDelDia,
  primerPeso,
  promedioPeso,
  ejerciciosDelDia,
  hoyLocal,
  pesoParaFecha,
  guardarBalanceDiario,
  borrarBalanceDiario,
  diaCerrado,
  historialBalance,
  diasPendientesDeCierre,
  sincronizarHitos,
  hitosDeGrasa,
} from './db.js';

// Rachas que merecen un festejo especial.
const HITOS_RACHA = [3, 7, 14, 21, 30, 60, 90, 180, 365];

// Referencia aproximada: 7.700 kcal de déficit neto equivalen a 1 kg de grasa corporal.
const KCAL_POR_KILO_DE_GRASA = 7700;

// Factor que multiplica a la TMB según la rutina diaria (incluye también la digestión).
// Describe solo la rutina, SIN ejercicio: el ejercicio se anota y se suma aparte. Por eso son más
// bajos que los factores habituales (1,375, 1,55...), que ya lo incluyen y lo contarían dos veces.
const NIVELES_DE_ACTIVIDAD = {
  poca: { factor: 1.2, texto: 'poca actividad diaria' },
  media: { factor: 1.3, texto: 'actividad diaria media' },
  mucha: { factor: 1.4, texto: 'mucha actividad diaria' },
};

// Quien todavía no eligió se considera mayormente sedentario.
function factorDeActividad(usuario) {
  return NIVELES_DE_ACTIVIDAD[usuario.actividad]?.factor ?? NIVELES_DE_ACTIVIDAD.poca.factor;
}

// Un día cuenta para el progreso solo con esta cantidad de comidas o más: con menos,
// lo más probable es que falte anotar algo y el déficit sería irreal.
const MINIMO_COMIDAS_PARA_CONTAR = 2;

// Por debajo de esta diferencia (en kcal) el día se considera en equilibrio: la estimación no da para más.
const MARGEN_EQUILIBRIO = 100;

// Un déficit mayor a este suele ser una comida sin anotar. Se lo marcamos en vez de festejarlo.
const DEFICIT_MUY_GRANDE = 1000;

// ---------- Formato de números ----------

// Redondea a un decimal para no mostrar restos como -0.4000000001.
function unDecimal(valor) {
  return Math.round(valor * 10) / 10;
}

// 102.14 → "102,1"
export function enKg(valor) {
  return valor.toLocaleString('es-AR', { maximumFractionDigits: 1 });
}

// 1250 → "1,25"
export function enLitros(ml) {
  return (ml / 1000).toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

// 1320.4 → "1.320"
export function enKcal(kcal) {
  return Math.round(kcal).toLocaleString('es-AR');
}

// "2026-10-16" → "16/10"
function diaYMes(fecha) {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`;
}

// ---------- Metas ----------

export function textoMetas(usuario) {
  const peso = usuario.pesoObjetivo ? `${enKg(usuario.pesoObjetivo)} kg` : 'sin definir';
  const kcal = usuario.metaKcal ? `${enKcal(usuario.metaKcal)} kcal por día` : 'sin definir';
  return [
    'Tus metas:',
    `⚖️ Peso: ${peso}`,
    `🍽️ Calorías: ${kcal}`,
    `💧 Agua: ${enLitros(usuario.metaAguaMl)} L por día`,
    '',
    'Para cambiarlas, escribime por ejemplo:',
    '"quiero llegar a 85 kilos"',
    '"quiero comer 1600 calorías por día"',
    '"quiero tomar 2 litros de agua por día"',
  ].join('\n');
}

// ---------- TMB y balance del día ----------

// Tasa metabólica basal con la fórmula de Mifflin-St Jeor: lo que el cuerpo gasta en reposo.
// Devuelve null si falta algún dato. Usa el último peso, así se actualiza sola al pesarse.
function calcularTmb(usuario, kg, fecha) {
  if (!usuario.sexo || !usuario.anioNacimiento || !usuario.alturaCm || kg === null) return null;
  const edad = Number(fecha.slice(0, 4)) - usuario.anioNacimiento;
  const ajustePorSexo = usuario.sexo === 'hombre' ? 5 : -161;
  return Math.round(10 * kg + 6.25 * usuario.alturaCm - 5 * edad + ajustePorSexo);
}

// El resultado que se muestra al terminar las preguntas o al tocar "Mi TMB".
export function textoTmb(usuario, kg, fecha) {
  const edad = Number(fecha.slice(0, 4)) - usuario.anioNacimiento;
  const altura = (usuario.alturaCm / 100).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  return [
    `🔥 Tu TMB es de ~${enKcal(calcularTmb(usuario, kg, fecha))} kcal por día`,
    '',
    'Es lo que tu cuerpo gasta en reposo. Se actualiza sola cada vez que anotás tu peso.',
    `Sumando la actividad de todos los días y la digestión, gastás unas ${enKcal(calcularTmb(usuario, kg, fecha) * factorDeActividad(usuario))} kcal por día, sin contar el ejercicio (es una estimación).`,
    '',
    `Datos: ${usuario.sexo}, ${edad} años, ${altura} m, ${enKg(kg)} kg, ${NIVELES_DE_ACTIVIDAD[usuario.actividad].texto}`,
  ].join('\n');
}

// Junta los números del balance. Devuelve null si todavía no se puede calcular la TMB.
// tdee = gasto total estimado. saldo positivo = déficit (gastó más de lo que comió); negativo = superávit.
// "quemadas" ya está dentro del tdee: no se vuelve a sumar en ningún otro lado.
export async function datosBalance(usuario, fecha) {
  const tmb = calcularTmb(usuario, await pesoParaFecha(usuario.chatId, fecha), fecha);
  if (tmb === null) return null;

  const ejercicios = await ejerciciosDelDia(usuario.chatId, fecha);
  const consumidas = await kcalDelDia(usuario.chatId, fecha);
  const quemadas = ejercicios.reduce((suma, ejercicio) => suma + ejercicio.kcal, 0);
  const actividad = tmb * (factorDeActividad(usuario) - 1);
  const tdee = tmb + actividad + quemadas;
  return { tmb, actividad, tdee, consumidas, quemadas, ejercicios, saldo: tdee - consumidas };
}

// ---------- Progreso acumulado de grasa ----------

// Recorre el historial en orden y anota el primer día en que el acumulado llegó a cada kilo.
// Si después hubo superávits, el hito logrado se conserva.
function calcularHitos(historial) {
  const hitos = [];
  let acumulado = 0;
  for (const dia of historial) {
    acumulado += dia.saldo_kcal;
    while (acumulado >= (hitos.length + 1) * KCAL_POR_KILO_DE_GRASA) {
      hitos.push({ kg: hitos.length + 1, fecha: dia.fecha });
    }
  }
  return hitos;
}

// Guarda el balance del día y actualiza los hitos. Se puede llamar las veces que haga falta.
// Un día con pocas comidas no cuenta (y si ya contaba, sale): sería un déficit inventado.
export async function cerrarDia(usuario, fecha) {
  const balance = await datosBalance(usuario, fecha);
  if (!balance) return;

  const cantidadDeComidas = (await comidasDelDia(usuario.chatId, fecha)).length;
  if (cantidadDeComidas < MINIMO_COMIDAS_PARA_CONTAR) {
    await borrarBalanceDiario(usuario.chatId, fecha);
  } else {
    await guardarBalanceDiario(usuario.chatId, fecha, balance);
  }
  await sincronizarHitos(usuario.chatId, calcularHitos(await historialBalance(usuario.chatId)));
}

// Se llama después de cambiar una comida, un ejercicio o un peso. Un día anterior o uno ya
// cerrado se recalcula; el día de hoy, si sigue abierto, se cierra recién a la noche.
export async function actualizarSiCorresponde(usuario, fecha) {
  if (fecha < hoyLocal() || (await diaCerrado(usuario.chatId, fecha))) {
    await cerrarDia(usuario, fecha);
  }
}

// Cierra los días que hayan quedado sin cerrar (por ejemplo, si el bot estuvo apagado).
export async function cerrarDiasPendientes(usuario, hasta) {
  for (const fecha of await diasPendientesDeCierre(usuario.chatId, hasta, MINIMO_COMIDAS_PARA_CONTAR)) {
    await cerrarDia(usuario, fecha);
  }
}

// Recalcula todo el historial. Hace falta cuando cambian sexo, edad, altura o actividad.
export async function recalcularHistorial(usuario) {
  const hoy = hoyLocal();
  for (const fecha of await diasConComidas(usuario.chatId)) {
    await actualizarSiCorresponde(usuario, fecha);
  }
  await cerrarDiasPendientes(usuario, sumarDias(hoy, -1));
}

// Barra hacia el próximo kilo, con lo que falta y la pérdida teórica. Devuelve null si
// todavía no hay ningún día cerrado.
export async function textoProgresoGrasa(usuario) {
  const historial = await historialBalance(usuario.chatId);
  if (historial.length === 0) return null;

  const acumulado = historial.reduce((suma, dia) => suma + dia.saldo_kcal, 0);
  const hitos = await hitosDeGrasa(usuario.chatId);
  // Con el acumulado en negativo todavía no hay avance hacia el primer kilo.
  const haciaElProximo = acumulado > 0 ? acumulado % KCAL_POR_KILO_DE_GRASA : 0;
  const porcentaje = Math.floor((haciaElProximo / KCAL_POR_KILO_DE_GRASA) * 100);
  const faltan = KCAL_POR_KILO_DE_GRASA - (acumulado > 0 ? haciaElProximo : acumulado);
  const kgTeoricos = Math.max(0, acumulado / KCAL_POR_KILO_DE_GRASA).toLocaleString('es-AR', { maximumFractionDigits: 2 });

  const lineas = [
    '🎯 Progreso acumulado de grasa (estimado)',
    `${barra(haciaElProximo, KCAL_POR_KILO_DE_GRASA, '🟩')} ${enKcal(haciaElProximo)} / ${enKcal(KCAL_POR_KILO_DE_GRASA)} kcal (${porcentaje}%)`,
    `Faltan ${enKcal(faltan)} kcal para el próximo kilo`,
    `Pérdida teórica: ~${kgTeoricos} kg en ${historial.length} ${historial.length === 1 ? 'día contado' : 'días contados'}`,
  ];
  if (acumulado < 0) lineas.push(`Por ahora el acumulado está en ${enKcal(acumulado)} kcal.`);
  if (hitos.length > 0) lineas.push(`🏅 Hitos logrados: ${hitos.map((hito) => `${hito.kg} kg`).join(', ')}`);
  lineas.push('Es una estimación energética, no una medición exacta de la grasa perdida.');
  return lineas.join('\n');
}

// Felicitaciones por los hitos que todavía no se le contaron. Devuelve null si no hay ninguno.
export async function textoHitosNuevos(usuario) {
  const nuevos = (await hitosDeGrasa(usuario.chatId)).filter((hito) => !hito.avisado);
  if (nuevos.length === 0) return null;
  return nuevos
    .map((hito) => `🏅 ¡Llegaste a ${hito.kg} kg de grasa perdida según tu balance! Es un cálculo teórico, pero refleja tu constancia. Seguimos hacia el siguiente 💪`)
    .join('\n');
}

function estadoDelSaldo(saldo) {
  if (Math.abs(saldo) < MARGEN_EQUILIBRIO) return 'equilibrio';
  return saldo > 0 ? 'déficit' : 'superávit';
}

// "déficit de ~400 kcal"
function textoEstado(saldo) {
  const estado = estadoDelSaldo(saldo);
  return estado === 'equilibrio' ? 'equilibrio' : `${estado} de ~${enKcal(Math.abs(saldo))} kcal`;
}

// Línea corta para el seguimiento durante el día. Sin comidas anotadas no dice nada:
// "déficit de 1.800 kcal" a la mañana solo significa que todavía no comió.
async function lineaBalance(usuario, fecha) {
  const balance = await datosBalance(usuario, fecha);
  if (!balance || balance.consumidas === 0) return null;
  return `Balance hasta ahora: ${textoEstado(balance.saldo)}`;
}

function nombresDeEjercicios(ejercicios) {
  return ejercicios.map((ejercicio) => ejercicio.descripcion.toLowerCase()).join(' + ');
}

// Respuesta al anotar un ejercicio.
export async function mensajeEjercicio(usuario, ejercicio, fecha) {
  const quemadasHoy = (await ejerciciosDelDia(usuario.chatId, fecha)).reduce((suma, e) => suma + e.kcal, 0);
  const lineas = [
    `Anotado: 🏃 ${ejercicio.descripcion}, ${Math.round(ejercicio.minutos)} min ~${enKcal(ejercicio.kcal)} kcal ✅`,
    '',
    `Quemadas hoy: ~${enKcal(quemadasHoy)} kcal (estimado)`,
  ];
  const balance = await lineaBalance(usuario, fecha);
  if (balance) lineas.push(balance);
  return lineas.join('\n');
}

// Balance para el resumen de la noche. Devuelve null si no hay comidas anotadas, porque
// sin saber qué comió cualquier número sería inventado.
export async function balanceDelDia(usuario, fecha) {
  if ((await kcalDelDia(usuario.chatId, fecha)) === 0) return null;

  const balance = await datosBalance(usuario, fecha);
  if (!balance) return '🔥 Para ver si estás en déficit o superávit, tocá "🔥 Mi TMB" y calculamos tu metabolismo.';

  const { tmb, actividad, tdee, consumidas, quemadas, ejercicios, saldo } = balance;
  const detalle = ejercicios.length > 0 ? ` (${nombresDeEjercicios(ejercicios)})` : '';
  const lineas = [
    '⚖️ Balance del día (estimado)',
    `• TMB: ${enKcal(tmb)} kcal`,
    `• Actividad diaria y digestión: +${enKcal(actividad)} kcal`,
    `• Ejercicio: +${enKcal(quemadas)} kcal${detalle}`,
    `• Gasto total: ${enKcal(tdee)} kcal`,
    `• Consumidas: ${enKcal(consumidas)} kcal`,
    '',
    `Estado: ${textoEstado(saldo)}`,
  ];

  const cantidadDeComidas = (await comidasDelDia(usuario.chatId, fecha)).length;
  const estado = estadoDelSaldo(saldo);
  if (cantidadDeComidas < MINIMO_COMIDAS_PARA_CONTAR) {
    lineas.push(`Hoy anotaste ${cantidadDeComidas} comida, así que este día no suma a tu progreso: cuentan los días con ${MINIMO_COMIDAS_PARA_CONTAR} o más.`);
  } else if (estado === 'déficit' && saldo > DEFICIT_MUY_GRANDE) {
    lineas.push('Es bastante: fijate si te quedó alguna comida sin anotar 😉');
  } else if (estado === 'superávit') {
    lineas.push('Un día así no cambia nada: lo que cuenta es cómo viene la semana 💪');
  }
  lineas.push('', 'Son estimaciones, y las calorías del ejercicio pueden ser imprecisas. El peso de cada día también varía por agua y sal: eso no es un cambio real de grasa.');
  return lineas.join('\n');
}

// ---------- Barras de progreso ----------

// barra(1150, 1600, '🟩') → "🟩🟩🟩🟩🟩🟩⬜⬜" (8 casilleros)
function barra(actual, meta, simbolo) {
  const casilleros = 8;
  let llenos = Math.round((actual / meta) * casilleros);
  // El redondeo no debe mentir: con algo de avance se pinta al menos uno,
  // y la barra se llena recién al llegar a la meta.
  if (actual > 0) llenos = Math.max(llenos, 1);
  llenos = actual >= meta ? casilleros : Math.min(llenos, casilleros - 1);
  return simbolo.repeat(llenos) + '⬜'.repeat(casilleros - llenos);
}

// Sin meta de calorías mostramos solo el número.
// Si se pasa de la meta, la barra cambia de color pero sin retarla.
export function lineaKcal(kcal, usuario) {
  if (!usuario.metaKcal) {
    return `Total del día: ${enKcal(kcal)} kcal 🍽️`;
  }
  const simbolo = kcal > usuario.metaKcal ? '🟧' : '🟩';
  return `Calorías: ${barra(kcal, usuario.metaKcal, simbolo)} ${enKcal(kcal)} / ${enKcal(usuario.metaKcal)}`;
}

export function lineaAgua(ml, usuario) {
  return `💧 Agua: ${barra(ml, usuario.metaAguaMl, '🟦')} ${enLitros(ml)} / ${enLitros(usuario.metaAguaMl)} L`;
}

// ---------- Rachas ----------

// Cuenta cuántos días seguidos, hacia atrás desde "desde", aparecen en la lista de fechas.
function contarDiasSeguidos(fechas, desde) {
  const conjunto = new Set(fechas);
  let racha = 0;
  let dia = desde;
  while (conjunto.has(dia)) {
    racha++;
    dia = sumarDias(dia, -1);
  }
  return racha;
}

// Si hoy todavía no anotó nada, la racha sigue viva: se cuenta hasta ayer.
async function rachaComidas(usuario, fecha) {
  const dias = await diasConComidas(usuario.chatId);
  return contarDiasSeguidos(dias, fecha) || contarDiasSeguidos(dias, sumarDias(fecha, -1));
}

async function rachaAgua(usuario, fecha) {
  return contarDiasSeguidos(await diasConMetaDeAgua(usuario.chatId, usuario.metaAguaMl), fecha);
}

// Línea de racha para la primera comida del día: un logro si es un hito, o la racha si ya son 2+ días.
async function textoRachaComidas(usuario, fecha) {
  const racha = await rachaComidas(usuario, fecha);
  if (HITOS_RACHA.includes(racha)) return `🏅 ¡Logro! ${racha} días seguidos anotando tus comidas`;
  if (racha >= 2) return `🔥 Racha: ${racha} días seguidos anotando`;
  return null;
}

// ---------- Comida ----------

// Arma la respuesta después de anotar (o corregir) una comida. Ejemplo:
//
//   Anotado: almuerzo ~565 kcal ✅
//
//   Arroz amarillo con pollo, morrón y perejil
//
//   • Arroz amarillo: 250 g (243 kcal)
//   • Pollo en trozos: 90 g (209 kcal)
//
//   Proteínas 25 g · Carbohidratos 54 g · Grasas 25 g · Fibra 3 g
//
//   💡 ¡Buen plato! Si la próxima le sumás ensalada, te llena más 🥗
//
//   Calorías: 🟩🟩🟩🟩🟩🟩⬜⬜ 1.150 / 1.600
//
//   🔥 Racha: 6 días seguidos anotando
export async function mensajeComida({ usuario, encabezado, comida, fecha, descripcion = '', consejo = '', esPrimeraDelDia = false }) {
  const { items, totales } = comida;
  const bloques = [encabezado];

  if (descripcion) bloques.push(descripcion);
  bloques.push(items.map((item) => `• ${item.nombre}: ${Math.round(item.gramos)} g (${enKcal(item.nutrientes.kcal)} kcal)`).join('\n'));
  bloques.push(
    `Proteínas ${Math.round(totales.proteina_g)} g · Carbohidratos ${Math.round(totales.carbohidratos_g)} g · ` +
      `Grasas ${Math.round(totales.grasa_g)} g · Fibra ${Math.round(totales.fibra_g)} g`
  );
  if (consejo) bloques.push(`💡 ${consejo}`);
  bloques.push(lineaKcal(await kcalDelDia(usuario.chatId, fecha), usuario));

  const balance = await lineaBalance(usuario, fecha);
  if (balance) bloques.push(balance);

  // La racha se muestra solo con la primera comida del día, para no repetirla en cada mensaje.
  const racha = esPrimeraDelDia ? await textoRachaComidas(usuario, fecha) : null;
  if (racha) bloques.push(racha);

  return bloques.join('\n\n');
}

// ---------- Agua ----------

// Respuesta al sumar agua. Festeja cuando cruza la meta del día.
export async function mensajeAgua(usuario, mlAntes, mlAhora, fecha) {
  const lineas = [lineaAgua(mlAhora, usuario)];

  const cumplioRecien = mlAntes < usuario.metaAguaMl && mlAhora >= usuario.metaAguaMl;
  if (cumplioRecien) {
    lineas.push('', '🎉 ¡Cumpliste la meta de agua de hoy!');
    const racha = await rachaAgua(usuario, fecha);
    if (HITOS_RACHA.includes(racha)) lineas.push(`🏅 ¡Logro! ${racha} días seguidos cumpliendo el agua`);
    else if (racha >= 2) lineas.push(`💧 Racha de agua: ${racha} días seguidos`);
  }
  return lineas.join('\n');
}

// ---------- Peso ----------

// Qué parte del camino entre el peso inicial y la meta ya recorrió.
// Sirve tanto si la meta es bajar como si es subir de peso.
function textoMeta(kg, pesoInicial, objetivo) {
  const quiereBajar = pesoInicial >= objetivo;
  const llego = quiereBajar ? kg <= objetivo : kg >= objetivo;
  if (llego) {
    return `¡Llegaste a tu meta de ${enKg(objetivo)} kg! 🎉`;
  }
  const avance = Math.round(((pesoInicial - kg) / (pesoInicial - objetivo)) * 100);
  const falta = unDecimal(Math.abs(kg - objetivo));
  // Si se alejó de la meta, mostramos 0% en vez de un porcentaje negativo.
  return `Llevás el ${Math.max(0, avance)}% del camino a tu meta de ${enKg(objetivo)} kg (te faltan ${enKg(falta)} kg)`;
}

// El peso sube y baja hasta 1-2 kg de un día al otro (agua, sal), así que el
// promedio semanal muestra mejor si va bien. Devuelve null si faltan datos.
async function textoTendencia(usuario, fecha) {
  const estaSemana = await promedioPeso(usuario.chatId, sumarDias(fecha, -6), fecha);
  const semanaAnterior = await promedioPeso(usuario.chatId, sumarDias(fecha, -13), sumarDias(fecha, -7));
  if (estaSemana === null || semanaAnterior === null) return null;

  const cambio = unDecimal(estaSemana - semanaAnterior);
  const flecha = cambio < 0 ? '📉' : cambio > 0 ? '📈' : '➡️';
  const signo = cambio > 0 ? '+' : '';
  return `Promedio de esta semana: ${enKg(estaSemana)} kg (${signo}${enKg(cambio)} kg vs la semana anterior) ${flecha}`;
}

// Hitos de peso perdido: el primer kilo, cada 5 kg, y el 5% y 10% del peso inicial.
// Solo festeja al cruzar un hito por primera vez (comparando con el mínimo anterior),
// así no se repite cuando el peso sube y baja alrededor del mismo número.
function logrosDePeso(usuario, kg, pesoInicial, minimoAnterior) {
  const quiereSubir = usuario.pesoObjetivo && usuario.pesoObjetivo > pesoInicial;
  if (pesoInicial === null || minimoAnterior === null || quiereSubir) return [];

  const bajadoAntes = unDecimal(pesoInicial - minimoAnterior);
  const bajadoAhora = unDecimal(pesoInicial - kg);
  const cruzo = (kilos) => bajadoAhora >= kilos && bajadoAntes < kilos;

  const logros = [];
  if (cruzo(1)) logros.push('🏅 ¡Bajaste tu primer kilo! Así se empieza 💪');
  for (let kilos = 5; kilos <= bajadoAhora; kilos += 5) {
    if (cruzo(kilos)) logros.push(`🏅 ¡Ya bajaste ${kilos} kg! 👏`);
  }
  if (cruzo(unDecimal(pesoInicial * 0.05))) {
    logros.push('🏅 ¡Bajaste el 5% de tu peso inicial! Esto ya trae beneficios reales para tu salud 💚');
  }
  if (cruzo(unDecimal(pesoInicial * 0.1))) logros.push('🏅 ¡Bajaste el 10% de tu peso inicial! Enorme logro 🎉');
  return logros;
}

// Arma la respuesta después de anotar un peso. Ejemplo:
//
//   Anotado: 102,1 kg ✅
//
//   Bajaste 3,1 kg desde el inicio (-2,9%)
//   Llevás el 15% del camino a tu meta de 85 kg (te faltan 17,1 kg)
//   Promedio de esta semana: 102,4 kg (-0,6 kg vs la semana anterior) 📉
//   Desde la última vez: -0,4 kg
//
//   🏅 ¡Ya bajaste 5 kg! 👏
export async function mensajePeso({ usuario, kg, fecha, pesoInicial, pesoAnterior, minimoAnterior }) {
  const lineas = [`Anotado: ${enKg(kg)} kg ✅`, ''];

  if (pesoInicial === null) {
    lineas.push('Es tu primer registro: desde acá medimos el avance 💪');
  } else {
    const cambio = unDecimal(kg - pesoInicial);
    const porcentaje = unDecimal((cambio / pesoInicial) * 100);
    if (cambio < 0) lineas.push(`Bajaste ${enKg(-cambio)} kg desde el inicio (${enKg(porcentaje)}%)`);
    if (cambio > 0) lineas.push(`Subiste ${enKg(cambio)} kg desde el inicio (+${enKg(porcentaje)}%)`);
    if (cambio === 0) lineas.push('Estás igual que al inicio');
  }

  if (usuario.pesoObjetivo) {
    // En el primer registro, el peso de hoy es también el punto de partida.
    lineas.push(textoMeta(kg, pesoInicial ?? kg, usuario.pesoObjetivo));
  }

  const tendencia = await textoTendencia(usuario, fecha);
  if (tendencia) lineas.push(tendencia);

  if (pesoAnterior !== null) {
    const cambio = unDecimal(kg - pesoAnterior);
    if (cambio === 0) lineas.push('Desde la última vez: sin cambios');
    if (cambio < 0) lineas.push(`Desde la última vez: ${enKg(cambio)} kg`);
    // Una suba de un día para el otro casi siempre es agua: lo aclaramos para que no se desanime.
    if (cambio > 0) lineas.push(`Desde la última vez: +${enKg(cambio)} kg (es normal que varíe día a día; lo que importa es el promedio)`);
  }

  const logros = logrosDePeso(usuario, kg, pesoInicial, minimoAnterior);
  if (logros.length > 0) lineas.push('', ...logros);

  return lineas.join('\n');
}

// ---------- Contexto para Claude ----------

// Resumen del día en texto para que Claude responda preguntas y dé consejos con datos reales.
export async function contextoDelDia(usuario, fechaHora) {
  const fecha = fechaHora.slice(0, 10);
  const comidas = await comidasDelDia(usuario.chatId, fecha);
  const lineas = [`Persona: ${usuario.nombre ?? 'sin nombre'}.`, `Fecha y hora: ${fechaHora}.`];

  const metaKcal = usuario.metaKcal ? ` (meta: ${enKcal(usuario.metaKcal)} kcal)` : '';
  lineas.push(`Calorías de hoy: ${enKcal(await kcalDelDia(usuario.chatId, fecha))} kcal${metaKcal}.`);
  lineas.push(`Agua de hoy: ${enLitros(await aguaDelDia(usuario.chatId, fecha))} L (meta: ${enLitros(usuario.metaAguaMl)} L).`);

  if (comidas.length > 0) {
    const detalle = comidas.map((comida) => `${comida.tipo_comida} (${comida.items.map((item) => item.nombre).join(', ')})`);
    lineas.push(`Comidas de hoy: ${detalle.join('; ')}.`);
  } else {
    lineas.push('Todavía no anotó comidas hoy.');
  }

  const balance = await datosBalance(usuario, fecha);
  if (balance) {
    lineas.push(`TMB: ${enKcal(balance.tmb)} kcal. Gasto total estimado de hoy: ${enKcal(balance.tdee)} kcal.`);
    if (balance.consumidas > 0) lineas.push(`Balance estimado hasta ahora: ${textoEstado(balance.saldo)}.`);
    if (balance.ejercicios.length > 0) {
      lineas.push(`Ejercicio de hoy: ${nombresDeEjercicios(balance.ejercicios)} (~${enKcal(balance.quemadas)} kcal quemadas).`);
    }
  }

  const peso = await ultimoPeso(usuario.chatId);
  if (peso !== null) {
    const meta = usuario.pesoObjetivo ? ` (meta: ${enKg(usuario.pesoObjetivo)} kg)` : '';
    lineas.push(`Último peso: ${enKg(peso)} kg${meta}.`);
  }
  return lineas.join('\n');
}

// ---------- Resúmenes ----------

// Los mensajes del resumen semanal para una persona: primero el suyo y después el de los demás,
// para acompañarse entre todos. Quien no anotó nada en la semana no tiene resumen.
// Lo usan el envío de los domingos y el botón "Resumen semanal".
export async function resumenesSemanalesPara(chatIdDestino, fecha) {
  const propios = [];
  const deLosDemas = [];
  for (const chatId of config.telegramChatIds) {
    const usuario = await obtenerUsuario(chatId);
    const texto = await resumenSemanal(usuario, fecha);
    if (texto === null) continue;
    if (chatId === chatIdDestino) propios.push(texto);
    else deLosDemas.push(`👨‍👩‍👧 Así le fue a ${usuario.nombre ?? 'otro integrante'} esta semana\n\n${texto}`);
  }
  return [...propios, ...deLosDemas];
}

// Resumen del día: lo usan el botón "¿Cómo voy?" y el mensaje de cada noche.
// El de la noche lo pide sin la línea de balance, porque ahí va el balance completo.
export async function resumenDelDia(usuario, fecha, { conBalance = true } = {}) {
  const { chatId } = usuario;
  const cantidad = (await comidasDelDia(chatId, fecha)).length;
  const lineas = [];

  if (cantidad === 0) {
    lineas.push('Hoy todavía no anotaste comidas.');
  } else {
    lineas.push(`Comidas anotadas: ${cantidad}`, lineaKcal(await kcalDelDia(chatId, fecha), usuario));
  }
  lineas.push(lineaAgua(await aguaDelDia(chatId, fecha), usuario));

  const ejercicios = await ejerciciosDelDia(chatId, fecha);
  if (ejercicios.length > 0) {
    const quemadas = ejercicios.reduce((suma, ejercicio) => suma + ejercicio.kcal, 0);
    lineas.push(`Ejercicio: ${nombresDeEjercicios(ejercicios)} (~${enKcal(quemadas)} kcal)`);
  }

  const balance = conBalance ? await lineaBalance(usuario, fecha) : null;
  if (balance) lineas.push(balance);

  const peso = await ultimoPesoDelDia(chatId, fecha);
  if (peso) lineas.push(`Peso: ${enKg(peso.kg)} kg`);

  const racha = await rachaComidas(usuario, fecha);
  if (racha >= 2) lineas.push(`🔥 Racha: ${racha} días seguidos anotando`);

  return lineas.join('\n');
}

// Resumen de los últimos 7 días (terminando en "fecha"). Se escribe en forma neutra
// porque también les llega a los demás. Devuelve null si no anotó nada en la semana.
export async function resumenSemanal(usuario, fecha) {
  const { chatId } = usuario;
  const desde = sumarDias(fecha, -6);
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(desde, i));

  // Juntamos los datos de cada día de la semana una sola vez.
  const semana = [];
  for (const dia of dias) {
    semana.push({
      dia,
      comidas: (await comidasDelDia(chatId, dia)).length,
      kcal: await kcalDelDia(chatId, dia),
      agua: await aguaDelDia(chatId, dia),
    });
  }

  const diasAnotados = semana.filter((d) => d.comidas > 0);
  const diasConAgua = semana.filter((d) => d.agua >= usuario.metaAguaMl);
  const huboAgua = semana.some((d) => d.agua > 0);
  const huboPeso = (await promedioPeso(chatId, desde, fecha)) !== null;
  if (diasAnotados.length === 0 && !huboAgua && !huboPeso) return null;

  const lineas = [`📊 Resumen de la semana (${diaYMes(desde)} al ${diaYMes(fecha)})`, ''];
  lineas.push(`Días con comidas anotadas: ${diasAnotados.length} de 7`);

  // El promedio se calcula solo con los días anotados: un día sin anotar no es un día sin comer.
  if (diasAnotados.length > 0) {
    const totalKcal = diasAnotados.reduce((suma, d) => suma + d.kcal, 0);
    const meta = usuario.metaKcal ? ` (meta: ${enKcal(usuario.metaKcal)})` : '';
    lineas.push(`Promedio de calorías: ${enKcal(totalKcal / diasAnotados.length)} kcal por día${meta}`);
  }
  lineas.push(`Días con la meta de agua cumplida: ${diasConAgua.length} de 7`);

  const tendencia = await textoTendencia(usuario, fecha);
  if (tendencia) lineas.push(tendencia);

  const inicial = await primerPeso(chatId);
  const actual = await ultimoPeso(chatId);
  if (inicial !== null && actual !== null && inicial !== actual) {
    const cambio = unDecimal(actual - inicial);
    lineas.push(`Desde el inicio: ${cambio > 0 ? '+' : ''}${enKg(cambio)} kg`);
  }

  const racha = await rachaComidas(usuario, fecha);
  if (racha >= 2) lineas.push(`🔥 Racha actual: ${racha} días seguidos anotando`);

  lineas.push('', diasAnotados.length >= 5 ? '¡Gran semana! Seguí así 💪' : 'Cada día que anotás suma. ¡Vamos por una gran semana! 💪');
  return lineas.join('\n');
}
