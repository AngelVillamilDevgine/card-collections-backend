// El freno a la fuerza bruta, sin base y con el reloj en la mano.
//
// Vivía en un closure de `armarServidor` y por eso no tenía un solo test: las dos reglas
// que más importan —el tope de baldes y a quién se desaloja— piden cinco mil baldes, o sea
// cinco mil scrypt si se prueba por HTTP. Nadie corre ese test, y las dos estaban mal.
//
// Los tests de `api.test.js` siguen cubriendo lo que sí se puede ver por HTTP: que el tope
// frene, que la cabecera inventada no estrene contador y que entrar a una cuenta propia no
// sirva de botón de reinicio. Acá está lo que ahí no se puede llegar a tocar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLimiter, MAX_BUCKETS, MAX_KEY_PART, WINDOW } from '../src/limiter.js'

/* Un reloj de mentira: el freno tiene una ventana de 15 minutos y no se va a esperar. */
function conReloj(opciones = {}) {
  let t = 1_000_000
  const freno = createLimiter({ ...opciones, now: () => t })
  return { freno, avanzar: (ms) => { t += ms }, ahora: () => t }
}

// ------------------------------------------------------------------ lo básico

test('cuenta fracasos y frena al llegar al tope, no antes', () => {
  const { freno } = conReloj()
  for (let i = 0; i < 9; i++) freno.fail('ip|vos')
  assert.equal(freno.blocked('ip|vos', 10), false, 'nueve fracasos todavía no frenan')
  freno.fail('ip|vos')
  assert.equal(freno.blocked('ip|vos', 10), true)
})

test('el balde vence solo: pasada la ventana deja de frenar', () => {
  const { freno, avanzar } = conReloj()
  for (let i = 0; i < 10; i++) freno.fail('ip|vos')
  assert.equal(freno.blocked('ip|vos', 10), true)
  avanzar(WINDOW + 1)
  assert.equal(freno.blocked('ip|vos', 10), false)
  /* Y el fracaso siguiente arranca de cero, no de diez. */
  freno.fail('ip|vos')
  assert.equal(freno.count('ip|vos'), 1)
})

test('perdonar borra ese balde y ninguno más', () => {
  const { freno } = conReloj()
  for (let i = 0; i < 10; i++) { freno.fail('ip|vos'); freno.fail('ip') }
  freno.forgive('ip|vos')
  assert.equal(freno.blocked('ip|vos', 10), false)
  assert.equal(freno.blocked('ip', 10), true, 'el de la IP no se toca: si no, es el botón de reinicio')
})

// ------------------------------------------------------------------ LEER NO CREA BALDE

test('preguntar si está frenado NO crea el balde', () => {
  /* Es la mitad del arreglo. `frenado` llamaba al creador, así que un pedido que ya salía
     frenado —429 antes del scrypt, o sea gratis para quien lo manda— igual estrenaba un
     balde por cada usuario inventado: el Map se llenaba sin pagar nada. */
  const { freno } = conReloj()
  for (let i = 0; i < 1000; i++) freno.blocked(`ip|inventado${i}`, 10)
  assert.equal(freno.size(), 0, 'mil preguntas y ningún balde')
})

test('llenar el Map cuesta un fracaso de verdad por balde', () => {
  const { freno } = conReloj()
  for (let i = 0; i < 100; i++) freno.fail(`ip|inventado${i}`)
  assert.equal(freno.size(), 100)
})

// ------------------------------------------------------------------ EL TOPE CUENTA BYTES

test('la llave se corta, porque el tope cuenta BALDES y no bytes', () => {
  /* El usuario sale del cuerpo del pedido y la IP de una cabecera. Con un usuario de un
     megabyte —el límite de cuerpo de Fastify— cinco mil baldes son cinco gigas en un
     proceso de 256 MB: alcanzaban unos trescientos pedidos para voltear la API. */
  const { freno } = conReloj()
  const enorme = 'a'.repeat(1024 * 1024)
  const llave = freno.key('10.0.0.1', enorme)
  assert.ok(llave.length <= MAX_KEY_PART * 2 + 1, `la llave mide ${llave.length}`)
  assert.equal(llave, '10.0.0.1|' + 'a'.repeat(MAX_KEY_PART))
})

test('la memoria del Map lleno queda acotada de verdad', () => {
  const { freno } = conReloj()
  const enorme = 'b'.repeat(1024 * 1024)
  for (let i = 0; i < MAX_BUCKETS; i++) freno.fail(freno.key('10.0.0.1', i + enorme))
  /* No se puede medir el heap acá sin ruido, así que se mide lo que lo causa: el largo
     total de las llaves. Con el corte son ~650 KB; sin él eran cinco gigas. */
  assert.ok(freno.size() <= MAX_BUCKETS)
  const bytes = MAX_BUCKETS * (MAX_KEY_PART * 2 + 1)
  assert.ok(bytes < 5 * 1024 * 1024, `${bytes} bytes de llaves`)
})

test('una llave con partes que faltan no revienta ni dice «undefined»', () => {
  const { freno } = conReloj()
  assert.equal(freno.key('ip', undefined), 'ip|')
  assert.equal(freno.key('ip', null), 'ip|')
  assert.equal(freno.key('clave', 7), 'clave|7', 'un id numérico sí se usa')
})

// ------------------------------------------------------------------ EL DESALOJO

test('EL DESALOJO NO ES UN BOTÓN DE REINICIO: se tira al que menos sabe', () => {
  /* Tirando por antigüedad —un Map itera por orden de inserción— el atacante decide qué es
     viejo: llenaba el Map con baldes nuevos y hacía caer el contador de su propia IP. Es
     el mismo botón de reinicio que las dos llaves vinieron a sacarle, por la puerta de al
     lado. */
  const { freno, avanzar } = conReloj({ maxBuckets: 100 })

  /* El balde del atacante es el PRIMERO, o sea el más viejo. */
  for (let i = 0; i < 20; i++) freno.fail('ip-atacante')
  assert.equal(freno.blocked('ip-atacante', 20), true)

  /* Y ahora inunda con baldes nuevos, de a un fracaso cada uno. */
  avanzar(1000)
  for (let i = 0; i < 500; i++) freno.fail(`ip-atacante|victima${i}`)

  assert.ok(freno.size() <= 100, 'el tope se respeta')
  assert.equal(freno.blocked('ip-atacante', 20), true,
    'el balde del atacante sobrevivió a su propia inundación')
  assert.equal(freno.count('ip-atacante'), 20)
})

test('el desalojo tira primero los vencidos, que ya no frenan a nadie', () => {
  const { freno, avanzar } = conReloj({ maxBuckets: 10 })
  for (let i = 0; i < 5; i++) for (let k = 0; k < 10; k++) freno.fail(`viejo${i}`)
  avanzar(WINDOW + 1)
  /* Cinco baldes vencidos con diez fracasos, y uno nuevo con uno solo. */
  freno.fail('nuevo')
  for (let i = 0; i < 8; i++) freno.fail(`relleno${i}`)
  assert.equal(freno.count('nuevo'), 1, 'el de un solo fracaso, pero vivo, se quedó')
  for (let i = 0; i < 5; i++)
    assert.equal(freno.blocked(`viejo${i}`, 10), false, 'los vencidos no frenan igual')
})

test('un balde que llegó al tope le gana a mil que llegaron a uno', () => {
  const { freno } = conReloj({ maxBuckets: 50 })
  for (let i = 0; i < 10; i++) freno.fail('ip|victima')
  for (let i = 0; i < 300; i++) freno.fail(`ip|ruido${i}`)
  assert.equal(freno.blocked('ip|victima', 10), true, 'el que sabe algo se guarda')
})

test('el barrido saca los vencidos y deja los vivos', () => {
  const { freno, avanzar } = conReloj()
  freno.fail('viejo')
  avanzar(WINDOW + 1)
  freno.fail('nuevo')
  assert.equal(freno.size(), 2)
  freno.sweep()
  assert.equal(freno.size(), 1)
  assert.equal(freno.count('nuevo'), 1)
})
