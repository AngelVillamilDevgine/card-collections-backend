// Las guardas del único camino que borra en masa. Sin base: son funciones puras, y por
// eso mismo se pueden probar todas las formas raras de archivo sin levantar nada.
//
// Lo que protegen: `PUT /api/coleccion` y `bin/import-collection.js` reemplazan la colección
// ENTERA. Hasta hoy el script no tenía ninguna de las tres guardas que sí tenía la ruta,
// así que un `null`, un `[]` o el json de cualquier otra cosa borraba todo y contestaba
// «Listo: 0 cartas» — justo la herramienta que se usa para recuperar un respaldo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBackup, validateReplacement, MAX_REPLACE_KEYS, countLostCards } from '../src/collection.js'

test('normalizeBackup rechaza lo que no es una copia', () => {
  // Cada uno de éstos se convertía antes en una colección vacía perfectamente válida.
  for (const garbage of [null, undefined, 0, 1, '', 'hola', [], [1, 2, 3], true]) {
    assert.equal(normalizeBackup(garbage), null, `debería rechazar ${JSON.stringify(garbage)}`)
  }
})

test('normalizeBackup rechaza el json de otra cosa', () => {
  // Un package.json entraba entero como si fuera un mapa de estados suelto.
  assert.equal(normalizeBackup({ name: 'algo', version: '1.0.0', scripts: {} }), null)
  // Un objeto vacío tampoco es una copia: es un archivo que no dice nada.
  assert.equal(normalizeBackup({}), null)
  // Y si UNA sola clave no tiene forma de carta, no es un mapa de estados.
  assert.equal(normalizeBackup({ 'exp-1:1': 'bien', notas: 'me faltan varias' }), null)
})

test('normalizeBackup lee la forma de hoy', () => {
  const r = normalizeBackup({ estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } })
  assert.deepEqual(r, { estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } })
})

test('normalizeBackup lee la forma con "repetidas", que contaba las que SOBRABAN', () => {
  const r = normalizeBackup({ estados: { 'exp-1:1': 'bien', 'exp-1:2': 'perfecta' }, repetidas: { 'exp-1:2': 3 } })
  assert.deepEqual(r.cantidades, { 'exp-1:1': 1, 'exp-1:2': 4 })
})

test('normalizeBackup lee el mapa de estados suelto, la forma más vieja', () => {
  const r = normalizeBackup({ 'exp-1:1': 'bien', 'bf-2:88': 'reemplazar' })
  assert.deepEqual(r.cantidades, { 'exp-1:1': 1, 'bf-2:88': 1 })
  assert.equal(r.estados['bf-2:88'], 'reemplazar')
})

test('normalizeBackup sobrevive a estados nulo', () => {
  // Una copia vieja o un archivo armado a mano deja esto, y antes reventaba más adelante.
  const r = normalizeBackup({ estados: null, cantidades: { 'exp-1:1': 1 } })
  assert.deepEqual(r, { estados: {}, cantidades: { 'exp-1:1': 1 } })
})

test('validateReplacement no deja pasar un reemplazo de cero cartas', () => {
  const error = validateReplacement({ estados: {}, cantidades: {} })
  assert.match(error, /ninguna carta/)
})

/* El caso que la guarda NO tapaba: claves válidas, todas en cero.
   Contando claves pasaba entero -- `validateCard` acepta la cantidad 0 a propósito, que es
   la que borra una carta sola -- y después `replaceCollection()` filtra por `n > 0` y no inserta
   nada. O sea: borraba la colección entera y contestaba 200 con `cartas: 0`. Verificado por
   los dos caminos contra la base de prueba antes de arreglarlo. */
test('validateReplacement cuenta CARTAS y no claves: todas en cero no es una copia', () => {
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': 0, 'exp-1:2': 0 } }), /ninguna carta/)
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': 0 } }), /ninguna carta/)
  // Una sola carta de verdad entre muchos ceros alcanza: no es el archivo equivocado.
  assert.equal(validateReplacement({ cantidades: { 'exp-1:1': 0, 'exp-1:2': 1 } }), null)
})

test('validateReplacement no deja pasar más del tope', () => {
  const quantities = {}
  for (let i = 0; i <= MAX_REPLACE_KEYS; i++) quantities[`exp-1:${i}`] = 1
  assert.match(validateReplacement({ cantidades: quantities }), /demasiadas cartas/)
})

test('validateReplacement mira clave por clave, no sólo el bloque', () => {
  assert.match(validateReplacement({ cantidades: { 'NO VALE': 1 } }), /Clave inválida/)
  // 41 caracteres antes de los dos puntos: no entra en el VARCHAR(40) con el número.
  assert.match(validateReplacement({ cantidades: { ['a'.repeat(41) + ':1']: 1 } }), /Clave inválida/)
})

test('validateReplacement valida las cantidades igual que el PUT de una carta sola', () => {
  // Antes este camino sólo hacía Number(n) y filtraba n > 0: todo esto entraba callado.
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': -3 } }), /entero entre 0 y 9999/)
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': 1.7 } }), /entero entre 0 y 9999/)
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': 999999999 } }), /entero entre 0 y 9999/)
  assert.match(validateReplacement({ cantidades: { 'exp-1:1': 'hola' } }), /entero entre 0 y 9999/)
})

test('validateReplacement rechaza un estado inventado', () => {
  const error = validateReplacement({ estados: { 'exp-1:1': 'brillante' }, cantidades: { 'exp-1:1': 1 } })
  assert.match(error, /Estado desconocido/)
})

test('validateReplacement deja pasar una copia buena', () => {
  assert.equal(validateReplacement({ estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } }), null)
  // Sin estado también vale: una carta puede no tener condición cargada.
  assert.equal(validateReplacement({ cantidades: { 'exp-1:1': 1 } }), null)
})

test('la cadena entera: un archivo que no es copia nunca llega a validateReplacement', () => {
  // Es el orden que usa bin/import-collection.js, y el que importa: si normalizeBackup devolviera
  // un objeto vacío en vez de null, validateReplacement lo frenaría igual por «cero cartas».
  // Las dos guardas se cubren entre sí a propósito.
  const data = normalizeBackup({ name: 'algo' })
  assert.equal(data, null)
  assert.match(validateReplacement({ estados: {}, cantidades: {} }), /ninguna carta/)
})

/* CUÁNTAS PERDÉS AL RESTAURAR. La resta de totales miente de tres formas distintas, y
   las tres están acá. `bin/import-collection.js` —la herramienta que se usa para RECUPERAR un
   respaldo— usó la resta hasta el 2026-09-27. */

test('cuenta las que TENÉS y la copia no trae, no la resta de totales', () => {
  const mine = {}
  for (let i = 1; i <= 546; i++) mine['exp-1:' + i] = 1
  /* Un respaldo viejo de 600 que comparte 480 con tus 546. */
  const backup = {}
  for (let i = 67; i <= 546; i++) backup['exp-1:' + i] = 1      // 480 compartidas
  for (let i = 1000; i <= 1119; i++) backup['exp-2:' + i] = 1   // 120 que vos no tenés
  assert.equal(Object.keys(mine).length, 546)
  assert.equal(Object.keys(backup).length, 600)
  assert.equal(countLostCards(mine, backup), 66, 'perdés las 66 que la copia no trae')
  /* Y la fórmula vieja daba un número NEGATIVO, así que el aviso no se dibujaba y el
     mensaje se leía como que ganabas. */
  assert.equal(546 - 600, -54)
})

test('el peor caso: mismo tamaño y ninguna en común, que la resta calla del todo', () => {
  const mine = { 'exp-1:1': 1, 'exp-1:2': 1, 'exp-1:3': 1 }
  const backup = { 'exp-2:200': 1, 'exp-2:201': 1, 'exp-2:202': 1 }
  assert.equal(countLostCards(mine, backup), 3, 'las perdés TODAS')
  assert.equal(3 - 3, 0, 'y la resta decía que no perdías ninguna')
})

test('una clave en cero no es una carta, de ninguno de los dos lados', () => {
  /* Del lado de la copia: traerla en cero es borrarla, así que se pierde. */
  assert.equal(countLostCards({ 'exp-1:1': 2 }, { 'exp-1:1': 0 }), 1)
  /* Y del tuyo: una fila en cero no es una carta que puedas perder. */
  assert.equal(countLostCards({ 'exp-1:1': 0 }, {}), 0)
})

test('sobrevive a que falten los mapas', () => {
  assert.equal(countLostCards(null, null), 0)
  assert.equal(countLostCards(undefined, { 'exp-1:1': 1 }), 0)
  assert.equal(countLostCards({ 'exp-1:1': 1 }, undefined), 1)
})
