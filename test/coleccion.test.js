// Las guardas del único camino que borra en masa. Sin base: son funciones puras, y por
// eso mismo se pueden probar todas las formas raras de archivo sin levantar nada.
//
// Lo que protegen: `PUT /api/coleccion` y `bin/importar.js` reemplazan la colección
// ENTERA. Hasta hoy el script no tenía ninguna de las tres guardas que sí tenía la ruta,
// así que un `null`, un `[]` o el json de cualquier otra cosa borraba todo y contestaba
// «Listo: 0 cartas» — justo la herramienta que se usa para recuperar un respaldo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizarCopia, revisarReemplazo, TOPE_CARTAS } from '../src/coleccion.js'

test('normalizarCopia rechaza lo que no es una copia', () => {
  // Cada uno de éstos se convertía antes en una colección vacía perfectamente válida.
  for (const basura of [null, undefined, 0, 1, '', 'hola', [], [1, 2, 3], true]) {
    assert.equal(normalizarCopia(basura), null, `debería rechazar ${JSON.stringify(basura)}`)
  }
})

test('normalizarCopia rechaza el json de otra cosa', () => {
  // Un package.json entraba entero como si fuera un mapa de estados suelto.
  assert.equal(normalizarCopia({ name: 'algo', version: '1.0.0', scripts: {} }), null)
  // Un objeto vacío tampoco es una copia: es un archivo que no dice nada.
  assert.equal(normalizarCopia({}), null)
  // Y si UNA sola clave no tiene forma de carta, no es un mapa de estados.
  assert.equal(normalizarCopia({ 'exp-1:1': 'bien', notas: 'me faltan varias' }), null)
})

test('normalizarCopia lee la forma de hoy', () => {
  const r = normalizarCopia({ estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } })
  assert.deepEqual(r, { estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } })
})

test('normalizarCopia lee la forma con "repetidas", que contaba las que SOBRABAN', () => {
  const r = normalizarCopia({ estados: { 'exp-1:1': 'bien', 'exp-1:2': 'perfecta' }, repetidas: { 'exp-1:2': 3 } })
  assert.deepEqual(r.cantidades, { 'exp-1:1': 1, 'exp-1:2': 4 })
})

test('normalizarCopia lee el mapa de estados suelto, la forma más vieja', () => {
  const r = normalizarCopia({ 'exp-1:1': 'bien', 'bf-2:88': 'reemplazar' })
  assert.deepEqual(r.cantidades, { 'exp-1:1': 1, 'bf-2:88': 1 })
  assert.equal(r.estados['bf-2:88'], 'reemplazar')
})

test('normalizarCopia sobrevive a estados nulo', () => {
  // Una copia vieja o un archivo armado a mano deja esto, y antes reventaba más adelante.
  const r = normalizarCopia({ estados: null, cantidades: { 'exp-1:1': 1 } })
  assert.deepEqual(r, { estados: {}, cantidades: { 'exp-1:1': 1 } })
})

test('revisarReemplazo no deja pasar un reemplazo de cero cartas', () => {
  const mal = revisarReemplazo({ estados: {}, cantidades: {} })
  assert.match(mal, /ninguna carta/)
})

/* El caso que la guarda NO tapaba: claves válidas, todas en cero.
   Contando claves pasaba entero -- `revisarCarta` acepta la cantidad 0 a propósito, que es
   la que borra una carta sola -- y después `reemplazar()` filtra por `n > 0` y no inserta
   nada. O sea: borraba la colección entera y contestaba 200 con `cartas: 0`. Verificado por
   los dos caminos contra la base de prueba antes de arreglarlo. */
test('revisarReemplazo cuenta CARTAS y no claves: todas en cero no es una copia', () => {
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': 0, 'exp-1:2': 0 } }), /ninguna carta/)
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': 0 } }), /ninguna carta/)
  // Una sola carta de verdad entre muchos ceros alcanza: no es el archivo equivocado.
  assert.equal(revisarReemplazo({ cantidades: { 'exp-1:1': 0, 'exp-1:2': 1 } }), null)
})

test('revisarReemplazo no deja pasar más del tope', () => {
  const cantidades = {}
  for (let i = 0; i <= TOPE_CARTAS; i++) cantidades[`exp-1:${i}`] = 1
  assert.match(revisarReemplazo({ cantidades }), /demasiadas cartas/)
})

test('revisarReemplazo mira clave por clave, no sólo el bloque', () => {
  assert.match(revisarReemplazo({ cantidades: { 'NO VALE': 1 } }), /Clave inválida/)
  // 41 caracteres antes de los dos puntos: no entra en el VARCHAR(40) con el número.
  assert.match(revisarReemplazo({ cantidades: { ['a'.repeat(41) + ':1']: 1 } }), /Clave inválida/)
})

test('revisarReemplazo valida las cantidades igual que el PUT de una carta sola', () => {
  // Antes este camino sólo hacía Number(n) y filtraba n > 0: todo esto entraba callado.
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': -3 } }), /entero entre 0 y 9999/)
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': 1.7 } }), /entero entre 0 y 9999/)
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': 999999999 } }), /entero entre 0 y 9999/)
  assert.match(revisarReemplazo({ cantidades: { 'exp-1:1': 'hola' } }), /entero entre 0 y 9999/)
})

test('revisarReemplazo rechaza un estado inventado', () => {
  const mal = revisarReemplazo({ estados: { 'exp-1:1': 'brillante' }, cantidades: { 'exp-1:1': 1 } })
  assert.match(mal, /Estado desconocido/)
})

test('revisarReemplazo deja pasar una copia buena', () => {
  assert.equal(revisarReemplazo({ estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } }), null)
  // Sin estado también vale: una carta puede no tener condición cargada.
  assert.equal(revisarReemplazo({ cantidades: { 'exp-1:1': 1 } }), null)
})

test('la cadena entera: un archivo que no es copia nunca llega a revisarReemplazo', () => {
  // Es el orden que usa bin/importar.js, y el que importa: si normalizarCopia devolviera
  // un objeto vacío en vez de null, revisarReemplazo lo frenaría igual por «cero cartas».
  // Las dos guardas se cubren entre sí a propósito.
  const datos = normalizarCopia({ name: 'algo' })
  assert.equal(datos, null)
  assert.match(revisarReemplazo({ estados: {}, cantidades: {} }), /ninguna carta/)
})
