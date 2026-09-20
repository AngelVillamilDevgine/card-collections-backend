// Las estadísticas son sólo para el admin. Lo que más importa acá es que alguien que no
// lo es no pueda ver los mails ni los datos del resto.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { olvidarVisitas, hoyAca } from '../src/estadisticas.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
const ADMIN = 'jefe@ejemplo.com'
const OTRO = 'cualquiera@ejemplo.com'

let pool
let app

before(async () => {
  // Antes de importar el servidor: la lista de admins se lee al cargar el módulo.
  process.env.DBZ_ADMINS = ADMIN
  const { crearApp } = await import('../src/servidor.js')
  pool = conectar(URL)
  await prepararEsquema(pool)
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  delete process.env.DBZ_ADMINS
  await app?.close()
  await pool?.end()
})

/* Se vacía también el Map de visitas, que es de módulo y sobrevive al DELETE. Ver la
   nota larga en api.test.js: hoy no haría falta, pero deja de ser una trampa. */
beforeEach(async () => {
  await pool.query('DELETE FROM usuario')
  olvidarVisitas()
})

/* Una IP por registro: el freno a la fuerza bruta es por IP y el balde vive en el
   `app`, que es uno solo para todo el archivo. Ahora que el registro también frena, sin
   esto los tests se comerían el balde entre ellos. */
let cliente = 0

const registrar = async (usuario) => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro', payload: { usuario, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++cliente}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

test('el que no es admin no ve nada, y ni se entera de que existe', async () => {
  const token = await registrar(OTRO)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(token) })
  assert.equal(r.statusCode, 404)
})

/* Esto es lo que hace que el panel sirva para decidir algo: si "volvieron otro día"
   se midiera con las sesiones, el que entra una vez y usa la app todos los días
   contaría como que no volvió, porque la sesión dura 30 días. */
test('usar la app anota el día, aunque no se entre de nuevo', async () => {
  const token = await registrar(OTRO)
  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })

  // La visita se anota sin esperarla, así que se le da un momento.
  let filas = []
  for (let i = 0; i < 40 && !filas.length; i++) {
    ;[filas] = await pool.query('SELECT dia FROM visita')
    if (!filas.length) await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(filas.length, 1, 'tendría que haber un día anotado, y uno solo')

  // Y mil pedidos más del mismo día no agregan filas.
  for (let i = 0; i < 5; i++)
    await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  const [despues] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(despues[0].n), 1)
})

/* Saber cuántos la instalaron es lo que va a decir si el aviso sirvió. Y una vez que
   el día quedó marcado como app, entrar por el navegador no lo tiene que borrar. */
test('entrar como app queda anotado, y el navegador no lo pisa', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro?app=1', payload: { usuario: OTRO, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++cliente}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  const token = r.json().token

  let filas = []
  for (let i = 0; i < 40 && !filas.length; i++) {
    ;[filas] = await pool.query('SELECT app FROM visita')
    if (!filas.length) await new Promise((r2) => setTimeout(r2, 25))
  }
  assert.equal(Number(filas[0].app), 1, 'el día tendría que haber quedado marcado como app')

  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  await new Promise((r2) => setTimeout(r2, 150))
  const [despues] = await pool.query('SELECT app, COUNT(*) n FROM visita GROUP BY app')
  assert.equal(despues.length, 1)
  assert.equal(Number(despues[0].app), 1, 'un pedido desde el navegador no puede desmarcarlo')
  assert.equal(Number(despues[0].n), 1)

  const resumen = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(await registrar(ADMIN)) })
  assert.equal(resumen.json().usuarios.conApp, 1)
})

/* Abrir el panel anotaba tu visita del día ANTES de calcular nada, así que inflaba con
   tus propios chequeos los dos números que el panel existe para mostrar.

   El `?app=1` no es un detalle: la marca en memoria de anotarVisita lleva si vino de la
   app, así que con él la llave es distinta de la que dejó el registro. Sin eso el test
   pasaría solo, tapado por el cache, sin probar nada. */
test('abrir el panel no cuenta como usar la app', async () => {
  const jefe = await registrar(ADMIN)
  await pool.query('DELETE FROM visita')

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen?app=1', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  await new Promise((s) => setTimeout(s, 200))

  const [filas] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(filas[0].n), 0, 'mirar el panel no puede anotar una visita')

  // Y cualquier otra ruta sí la anota, para que se vea que el test discrimina.
  await app.inject({ method: 'GET', url: '/api/coleccion?app=1', headers: auth(jefe) })
  for (let i = 0; i < 40; i++) {
    const [f] = await pool.query('SELECT COUNT(*) n FROM visita')
    if (Number(f[0].n) > 0) break
    await new Promise((s) => setTimeout(s, 25))
  }
  const [despues] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(despues[0].n), 1, 'una ruta normal sí tiene que anotar')
})

/* El respaldo y el despliegue corren fuera de la app y, cuando fallan, no se entera
   nadie: el correo del servidor rebota antes de llegar a Gmail. Anotan en la base y el
   panel lo muestra, así que el resumen tiene que traerlo. */
test('el resumen trae la salud de lo que corre afuera', async () => {
  const jefe = await registrar(ADMIN)
  await pool.query(
    "INSERT INTO salud (clave, valor) VALUES ('respaldo', '{\"bytes\":20349,\"copias\":3}')" +
    ' ON DUPLICATE KEY UPDATE valor = VALUES(valor)'
  )
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  const { salud } = r.json()
  assert.ok(salud, 'el resumen tendría que traer salud')
  assert.equal(salud.respaldo.valor.bytes, 20349)
  assert.equal(salud.respaldo.valor.copias, 3)
  assert.ok(Number.isFinite(salud.respaldo.hace), 'y cuántos minutos hace')
})

test('sin sesión tampoco', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen' })
  assert.equal(r.statusCode, 401)
})

test('/api/yo dice quién es admin y quién no', async () => {
  const jefe = await registrar(ADMIN)
  const otro = await registrar(OTRO)
  const a = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(jefe) })
  const b = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(otro) })
  assert.equal(a.json().admin, true)
  assert.equal(b.json().admin, false)
})

test('el admin ve los números, y cuadran con lo que hay', async () => {
  const jefe = await registrar(ADMIN)
  const otro = await registrar(OTRO)
  // El admin marca dos cartas, una repetida; el otro no marca nada.
  for (const [clave, cantidad] of [['exp-1:1', 1], ['exp-1:2', 3]]) {
    await app.inject({ method: 'PUT', url: `/api/cartas/${clave}`, headers: auth(jefe), payload: { cantidad } })
  }
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  assert.equal(d.usuarios.total, 2, 'usuarios')
  assert.equal(d.usuarios.conCartas, 1, 'sólo uno marcó cartas')
  assert.equal(d.cartas.total, 2, 'dos cartas distintas')
  assert.equal(d.cartas.repetidas, 2, 'de una tiene 3, o sea 2 repetidas')
  assert.equal(d.gente.length, 2)

  const elJefe = d.gente.find((g) => g.usuario === ADMIN)
  assert.equal(elJefe.cartas, 2)
  assert.equal(elJefe.repetidas, 2)
  assert.equal(elJefe.dias, 1, 'entró un solo día')

  const elOtro = d.gente.find((g) => g.usuario === OTRO)
  assert.equal(elOtro.cartas, 0)
  // El que más tiene va primero: es la lista que se mira para decidir.
  assert.equal(d.gente[0].usuario, ADMIN)
})

/* #81. `volvieron` es EL número del panel: la pregunta no es cuánta gente entra sino
   cuánta vuelve. Es además el que ya estuvo mal una vez —se contaba con `sesion`, que
   dura 30 días, y el que entraba una vez y usaba la app todos los días figuraba como
   que no había vuelto nunca— y aun así no tenía ningún test. Acá se siembran visitas a
   mano, que es la única forma de tener días distintos sin esperar a mañana. */
test('volvieron cuenta días distintos, no sesiones ni pedidos', async () => {
  const jefe = await registrar(ADMIN)
  const vuelve = await registrar('vuelve@ejemplo.com')
  const unaVez = await registrar('unavez@ejemplo.com')
  assert.ok(vuelve && unaVez)

  const ids = {}
  const [filas] = await pool.query('SELECT id, usuario FROM usuario')
  for (const f of filas) ids[f.usuario] = f.id

  await pool.query('DELETE FROM visita')
  const hoy = hoyAca()
  await pool.query(
    'INSERT INTO visita (usuario_id, dia) VALUES (?, ?), (?, DATE_SUB(?, INTERVAL 1 DAY)), (?, ?)',
    [ids['vuelve@ejemplo.com'], hoy, ids['vuelve@ejemplo.com'], hoy, ids['unavez@ejemplo.com'], hoy]
  )
  // Y muchos pedidos del mismo día NO tienen que sumar: es el error que tuvo el panel.
  for (let i = 0; i < 5; i++)
    await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(unaVez) })

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()
  assert.equal(d.usuarios.volvieron, 1, 'sólo uno entró en dos días distintos')

  const elQueVuelve = d.gente.find((g) => g.usuario === 'vuelve@ejemplo.com')
  assert.equal(elQueVuelve.dias, 2, 'y su columna de días tiene que decir 2')
  assert.equal(d.gente.find((g) => g.usuario === 'unavez@ejemplo.com').dias, 1)
})

/* #60. El total del catálogo era un 1936 escrito a mano acá adentro, y el catálogo vive
   en el front y se edita sin recompilar. Ya no se manda: que el panel lo saque de donde
   está la verdad. Si alguien lo vuelve a agregar, que este test lo frene. */
test('el resumen ya no manda el tamaño del catálogo, que no es suyo', async () => {
  const jefe = await registrar(ADMIN)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.json().total, undefined, 'el catálogo lo conoce el front, no el servidor')
})

/* #61. `altas7` contaba con una ventana RODANTE de UTC (`creado > NOW() - INTERVAL 7
   DAY`, o sea las últimas 168 horas desde este instante) mientras que el gráfico de al
   lado agrupa por día de Argentina. Los dos números vivían en el mismo panel y no eran
   comparables: el día más viejo salía recortado por las horas que ya habían pasado hoy,
   así que la misma base daba números distintos según la hora a la que miraras.

   Lo que fija este test es justamente eso: con altas sembradas en horas extremas del
   día local, el resultado tiene que ser el mismo siempre. Las fechas se escriben en hora
   de Argentina y las convierte MySQL, que es donde vive la cuenta. */
test('las altas de los últimos 7 días se cuentan por día local, no por ventana rodante', async () => {
  const jefe = await registrar(ADMIN)
  await pool.query('DELETE FROM usuario WHERE usuario <> ?', [ADMIN])

  const hoy = hoyAca()
  const siembra = [
    ['justo-afuera@ejemplo.com', 7, '23:30:00'],  // último minuto del día que queda afuera
    ['justo-adentro@ejemplo.com', 6, '00:30:00'], // primer minuto del día que entra
    ['anteayer@ejemplo.com', 2, '12:00:00'],
  ]
  for (const [usuario, hace, hora] of siembra) {
    await pool.query(
      `INSERT INTO usuario (usuario, hash, creado)
       VALUES (?, 'x', CONVERT_TZ(CONCAT(DATE_SUB(?, INTERVAL ? DAY), ' ', ?), '-03:00', '+00:00'))`,
      [usuario, hoy, hace, hora]
    )
  }

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  // El admin se registró recién, así que entra; el de hace 7 días no, aunque sea 23:30.
  assert.equal(d.usuarios.altas7, 3,
    'tienen que entrar el admin, el de hace 6 días y el de hace 2 — y NO el de hace 7')

  // Y el gráfico tiene que cuadrar con ese número: los dos miden días locales.
  const desde = new Date(`${hoy}T00:00:00Z`)
  desde.setUTCDate(desde.getUTCDate() - 6)
  const corte = desde.toISOString().slice(0, 10)
  const enLosSiete = d.porDia.filter((x) => x.dia >= corte).reduce((a, x) => a + x.cuantos, 0)
  assert.equal(enLosSiete, d.usuarios.altas7,
    'el gráfico y el contador tienen que dar lo mismo: antes usaban ventanas distintas')

  // El de hace 7 días existe, pero cae fuera de la ventana: no es que se haya perdido.
  assert.equal(d.usuarios.total, 4)
})
