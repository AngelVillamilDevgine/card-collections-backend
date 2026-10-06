// Qué prefijo de clave es de qué colección lo dice el FRONT, que es el único lado que
// conoce el catálogo. Así que `parseCollections` es lo único del panel que recibe algo
// escrito por el cliente: se valida entero, con techo, y si viene mal devuelve `null` en
// vez de romperse — un front viejo contra un back nuevo no manda el parámetro, y el panel
// tiene que seguir andando sin partir nada.
//
// El reparto se hace en JS y no en un CASE armado con esos prefijos: sale más simple, no
// construye SQL con nada de afuera, y es lo único que puede hacer bien lo de los sufijos
// de variante, que es lo que `collectionOf` resuelve más abajo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCollections, collectionOf, matchExpansion } from '../src/stats.js'

/* A QUÉ HUECO APUNTA UN TRAMO, que es lo que hace falta para que el porcentaje del panel
   no mezcle unidades. `ley-6-dor:824` es una fila propia pero NO es un hueco del álbum: el
   hueco es la 824. Sin esto, el numerador contaba variantes y el denominador huecos, el
   número podía pasarse de 100% y el tope lo recortaba disfrazándolo de álbum completo. */
test('matchExpansion devuelve el prefijo que gana, no sólo la colección', () => {
  const cols = [
    { id: 'cromeros', expansionIds: ['exp-1', 'exp-2'] },
    { id: 'leyenda', expansionIds: ['ley-6', 'ley-2-3', 'ley-personajes'] },
  ]
  assert.deepEqual(matchExpansion('ley-6', cols), { col: 'leyenda', expansionId: 'ley-6' })
  assert.deepEqual(matchExpansion('ley-6-dor', cols), { col: 'leyenda', expansionId: 'ley-6' },
    'la variante apunta al hueco de su expansión')
  /* Un id con guiones adentro NO se puede partir por guion: `ley-2-3` es la expansión. */
  assert.deepEqual(matchExpansion('ley-2-3', cols), { col: 'leyenda', expansionId: 'ley-2-3' })
  assert.deepEqual(matchExpansion('ley-2-3-pla', cols), { col: 'leyenda', expansionId: 'ley-2-3' })
  assert.equal(matchExpansion('otra-cosa', cols), null)
  /* Y gana el MÁS LARGO, que es lo que evita que una variante se le cuelgue a otra
     expansión cuando un id es prefijo de otro. */
  const nested = [{ id: 'x', expansionIds: ['ley', 'ley-6'] }]
  assert.equal(matchExpansion('ley-6-dor', nested).expansionId, 'ley-6')
})

test('collectionOf sigue contestando lo mismo que antes', () => {
  /* Se reescribió encima de `matchExpansion`, así que lo que importa es que no haya cambiado. */
  const cols = [{ id: 'leyenda', expansionIds: ['ley-6'] }]
  assert.equal(collectionOf('ley-6', cols), 'leyenda')
  assert.equal(collectionOf('ley-6-dor', cols), 'leyenda')
  assert.equal(collectionOf('exp-1', cols), null)
})

test('sin parámetro, o con basura, devuelve null y el panel sigue andando', () => {
  for (const invalid of [undefined, null, '', 'no es json', '[]', '"texto"', '123',
                      '{}', '{"a":[]}', '{"a":"exp-1"}', '{"a":null}']) {
    assert.equal(parseCollections(invalid), null, `${JSON.stringify(invalid)} tendría que dar null`)
  }
})

test('un prefijo con forma rara se rechaza ENTERO, no se filtra', () => {
  /* Filtrar en silencio sería peor: el panel contestaría con una colección incompleta y
     los números se leerían como buenos. */
  for (const invalid of [
    '{"a":["../etc/passwd"]}',
    '{"a":["exp-1","x\';DROP TABLE carta;--"]}',
    '{"a":["exp 1"]}',
    '{"a":["EXP-1"]}',
    '{"a":["exp-1:"]}',
    `{"a":["${'x'.repeat(35)}"]}`,
    '{"UNA":["exp-1"]}',
  ]) {
    assert.equal(parseCollections(invalid), null, `${invalid} tendría que dar null`)
  }
})

test('lo válido pasa, con sus prefijos', () => {
  const r = parseCollections(JSON.stringify({
    cromeros: ['exp-1', 'exp-2', 'bf-1'],
    leyenda: ['ley-inicial', 'ley-2-3'],
  }))
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((c) => c.id), ['cromeros', 'leyenda'])
  assert.deepEqual(r[0].expansionIds, ['exp-1', 'exp-2', 'bf-1'])
  assert.equal(r[1].expansionIds.length, 2)
})

test('tiene techo, porque la llave la arma el cliente', () => {
  const tooManyCollections = {}
  for (let i = 0; i < 11; i++) tooManyCollections['c' + i] = ['exp-1']
  assert.equal(parseCollections(JSON.stringify(tooManyCollections)), null, 'más de 10 colecciones')

  const tooManyExpansionIds = { a: Array.from({ length: 201 }, (_, i) => 'exp-' + i) }
  assert.equal(parseCollections(JSON.stringify(tooManyExpansionIds)), null, 'más de 200 prefijos')

  const atLimit = { a: Array.from({ length: 200 }, (_, i) => 'exp-' + i) }
  assert.ok(parseCollections(JSON.stringify(atLimit)), '200 justos sí entran')
})

/* LO QUE COSTÓ DOS VUELTAS, medido contra producción las dos veces.
   La parte de la clave anterior a los dos puntos es el id de la expansión —`ley-6`— o ese
   id con el sufijo de una variante —`ley-6-dor`—. Comparando por igualdad, las once filas
   de variante que había cargadas caían fuera de toda colección: el reparto sumaba 8053
   contra un total de 8064, y el panel las anunciaba como «de un catálogo viejo» con el pie
   ofreciendo borrarlas. */
const COLS = parseCollections(JSON.stringify({
  cromeros: ['exp-1', 'exp-2', 'ocultas', 'bf-1'],
  leyenda: ['ley-6', 'ley-personajes', 'ley-f'],
}))

test('un tramo de variante es de la misma colección que su expansión', () => {
  assert.equal(collectionOf('ley-6', COLS), 'leyenda')
  assert.equal(collectionOf('ley-6-dor', COLS), 'leyenda', 'una variante NO es de otro catálogo')
  assert.equal(collectionOf('ley-personajes-cya', COLS), 'leyenda')
  assert.equal(collectionOf('exp-1', COLS), 'cromeros')
})

test('un tramo que no es de nadie devuelve null, y eso sí es huérfano', () => {
  assert.equal(collectionOf('viejo-9', COLS), null)
  assert.equal(collectionOf('exp-99', COLS), null)
  /* Ojo con el guion: `ley-` a secas no es prefijo válido de nada declarado. */
  assert.equal(collectionOf('ley-5', COLS), null)
})

test('no alcanza con que empiece igual: tiene que cortar en un guión', () => {
  /* `exp-10` empieza con `exp-1` y NO es una variante suya: si esto se rompe, las cartas
     de una expansión se cuentan en otra y nadie lo nota. */
  assert.equal(collectionOf('exp-10', COLS), null)
  assert.equal(collectionOf('ley-60', COLS), null)
})

test('gana el prefijo más largo', () => {
  /* Por si alguna vez un id es prefijo de otro: `ley-6-dor` tiene que ser de quien declare
     `ley-6-dor`, no de quien declare `ley-6`. */
  const overlapping = parseCollections(JSON.stringify({ a: ['ley-6'], b: ['ley-6-dor'] }))
  assert.equal(collectionOf('ley-6-dor', overlapping), 'b')
  assert.equal(collectionOf('ley-6-pla', overlapping), 'a')
})
