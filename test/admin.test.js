// Las estadísticas son sólo para el admin. Lo que más importa acá es que alguien que no
// lo es no pueda ver los mails ni los datos del resto.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createDbPool, prepareSchema } from '../src/db.js'
import { clearVisitMarks, todayInArgentina } from '../src/stats.js'

const TEST_DB_URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
const ADMIN = 'jefe@ejemplo.com'
const OTHER_USER = 'cualquiera@ejemplo.com'

let pool
let app

before(async () => {
  // Antes de importar el servidor: la lista de admins se lee al cargar el módulo.
  process.env.DBZ_ADMINS = ADMIN
  const { createApp } = await import('../src/servidor.js')
  pool = createDbPool(TEST_DB_URL)
  await prepareSchema(pool)
  app = createApp(pool)
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
  clearVisitMarks()
})

/* Una IP por registro: el freno a la fuerza bruta es por IP y el balde vive en el
   `app`, que es uno solo para todo el archivo. Ahora que el registro también frena, sin
   esto los tests se comerían el balde entre ellos. */
let clientSeq = 0

const register = async (user) => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro', payload: { usuario: user, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++clientSeq}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

test('el que no es admin no ve nada, y ni se entera de que existe', async () => {
  const token = await register(OTHER_USER)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(token) })
  assert.equal(r.statusCode, 404)
})

/* EL AVISO DE LA COPIA VIAJA EN `/api/yo`, y por eso hay test: es el contrato que hace que
   el aviso llegue a la app —que se abre todos los días— y no sólo al panel, que hay que
   acordarse de abrir. Si el campo desaparece, la marca del botón «Panel» deja de aparecer
   y no se rompe nada más: falla en silencio, que es la clase de cosa que este proyecto ata
   con un test. */
test('/api/yo le manda la salud al admin, y a nadie más', async () => {
  const adminMe = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(await register(ADMIN)) })
  assert.equal(adminMe.statusCode, 200)
  const body = adminMe.json()
  assert.equal(body.admin, true)
  assert.ok('salud' in body, 'al admin le tiene que llegar `salud`')

  /* Al resto NO, y no es sólo prolijidad: es información del servidor que no le sirve de
     nada a alguien que no puede hacer nada con ella. */
  const otherMe = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(await register(OTHER_USER)) })
  assert.equal(otherMe.json().admin, false)
  assert.ok(!('salud' in otherMe.json()), 'a quien no es admin no le va la salud')
})

/* Y que una salud que no se puede leer NO deje a nadie afuera de sus cartas: el aviso es
   accesorio y la app tiene que andar igual. Se rompe la tabla a propósito. */
test('si la salud no se puede leer, /api/yo contesta igual', async () => {
  const token = await register(ADMIN)
  await pool.query('RENAME TABLE salud TO salud_escondida')
  try {
    const r = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(token) })
    assert.equal(r.statusCode, 200, 'la app no puede caerse porque falle un aviso')
    assert.equal(r.json().usuario, ADMIN)
    assert.equal(r.json().salud, null)
  } finally {
    await pool.query('RENAME TABLE salud_escondida TO salud')
  }
})

/* Esto es lo que hace que el panel sirva para decidir algo: si "volvieron otro día"
   se midiera con las sesiones, el que entra una vez y usa la app todos los días
   contaría como que no volvió, porque la sesión dura 30 días. */
test('usar la app anota el día, aunque no se entre de nuevo', async () => {
  const token = await register(OTHER_USER)
  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })

  // La visita se anota sin esperarla, así que se le da un momento.
  let rows = []
  for (let i = 0; i < 40 && !rows.length; i++) {
    ;[rows] = await pool.query('SELECT dia FROM visita')
    if (!rows.length) await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(rows.length, 1, 'tendría que haber un día anotado, y uno solo')

  // Y mil pedidos más del mismo día no agregan filas.
  for (let i = 0; i < 5; i++)
    await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  const [afterward] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(afterward[0].n), 1)
})

/* Saber cuántos la instalaron es lo que va a decir si el aviso sirvió. Y una vez que
   el día quedó marcado como app, entrar por el navegador no lo tiene que borrar. */
test('entrar como app queda anotado, y el navegador no lo pisa', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro?app=1', payload: { usuario: OTHER_USER, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++clientSeq}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  const token = r.json().token

  let rows = []
  for (let i = 0; i < 40 && !rows.length; i++) {
    ;[rows] = await pool.query('SELECT app FROM visita')
    if (!rows.length) await new Promise((r2) => setTimeout(r2, 25))
  }
  assert.equal(Number(rows[0].app), 1, 'el día tendría que haber quedado marcado como app')

  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  await new Promise((r2) => setTimeout(r2, 150))
  const [afterward] = await pool.query('SELECT app, COUNT(*) n FROM visita GROUP BY app')
  assert.equal(afterward.length, 1)
  assert.equal(Number(afterward[0].app), 1, 'un pedido desde el navegador no puede desmarcarlo')
  assert.equal(Number(afterward[0].n), 1)

  const summary = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(await register(ADMIN)) })
  assert.equal(summary.json().usuarios.conApp, 1)
})

/* Abrir el panel anotaba tu visita del día ANTES de calcular nada, así que inflaba con
   tus propios chequeos los dos números que el panel existe para mostrar.

   El `?app=1` no es un detalle: la marca en memoria de recordUserVisit lleva si vino de la
   app, así que con él la llave es distinta de la que dejó el registro. Sin eso el test
   pasaría solo, tapado por el cache, sin probar nada. */
test('abrir el panel no cuenta como usar la app', async () => {
  const adminToken = await register(ADMIN)
  await pool.query('DELETE FROM visita')

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen?app=1', headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  await new Promise((s) => setTimeout(s, 200))

  const [rows] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(rows[0].n), 0, 'mirar el panel no puede anotar una visita')

  // Y cualquier otra ruta sí la anota, para que se vea que el test discrimina.
  await app.inject({ method: 'GET', url: '/api/coleccion?app=1', headers: auth(adminToken) })
  for (let i = 0; i < 40; i++) {
    const [f] = await pool.query('SELECT COUNT(*) n FROM visita')
    if (Number(f[0].n) > 0) break
    await new Promise((s) => setTimeout(s, 25))
  }
  const [afterward] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(afterward[0].n), 1, 'una ruta normal sí tiene que anotar')
})

/* El respaldo y el despliegue corren fuera de la app y, cuando fallan, no se entera
   nadie: el correo del servidor rebota antes de llegar a Gmail. Anotan en la base y el
   panel lo muestra, así que el resumen tiene que traerlo. */
test('el resumen trae la salud de lo que corre afuera', async () => {
  const adminToken = await register(ADMIN)
  await pool.query(
    "INSERT INTO salud (clave, valor) VALUES ('respaldo', '{\"bytes\":20349,\"copias\":3}')" +
    ' ON DUPLICATE KEY UPDATE valor = VALUES(valor)'
  )
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  const { salud: health } = r.json()
  assert.ok(health, 'el resumen tendría que traer salud')
  assert.equal(health.respaldo.valor.bytes, 20349)
  assert.equal(health.respaldo.valor.copias, 3)
  assert.ok(Number.isFinite(health.respaldo.hace), 'y cuántos minutos hace')
})

test('sin sesión tampoco', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen' })
  assert.equal(r.statusCode, 401)
})

test('/api/yo dice quién es admin y quién no', async () => {
  const adminToken = await register(ADMIN)
  const otherToken = await register(OTHER_USER)
  const a = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(adminToken) })
  const b = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(otherToken) })
  assert.equal(a.json().admin, true)
  assert.equal(b.json().admin, false)
})

test('el admin ve los números, y cuadran con lo que hay', async () => {
  const adminToken = await register(ADMIN)
  const otherToken = await register(OTHER_USER)
  // El admin marca dos cartas, una repetida; el otro no marca nada.
  for (const [cardKey, quantity] of [['exp-1:1', 1], ['exp-1:2', 3]]) {
    await app.inject({ method: 'PUT', url: `/api/cartas/${cardKey}`, headers: auth(adminToken), payload: { cantidad: quantity } })
  }
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  assert.equal(d.usuarios.total, 2, 'usuarios')
  assert.equal(d.usuarios.conCartas, 1, 'sólo uno marcó cartas')
  assert.equal(d.cartas.total, 2, 'dos cartas distintas')
  assert.equal(d.cartas.repetidas, 2, 'de una tiene 3, o sea 2 repetidas')
  assert.equal(d.gente.length, 2)

  const adminRow = d.gente.find((g) => g.usuario === ADMIN)
  assert.equal(adminRow.cartas, 2)
  assert.equal(adminRow.repetidas, 2)
  assert.equal(adminRow.dias, 1, 'entró un solo día')

  const otherRow = d.gente.find((g) => g.usuario === OTHER_USER)
  assert.equal(otherRow.cartas, 0)
  // El que más tiene va primero: es la lista que se mira para decidir.
  assert.equal(d.gente[0].usuario, ADMIN)
})

/* EL PORCENTAJE DEL PANEL MEZCLABA DOS UNIDADES, y Angel lo vio: «el contador % de leyenda
   está medio gagá — por un lado es % de las que te faltan y por otro lado % de las
   variantes». Tenía razón. El numerador eran FILAS de la base, y una variante es una fila
   propia; el denominador eran los HUECOS del álbum, y una variante nunca es un hueco. Con
   eso el número podía pasarse de 100% y el tope que lo recortaba lo disfrazaba de «álbum
   completo».

   Acá se siembra exactamente ese caso: una carta con su base y dos fondos —tres filas, UN
   hueco— y otra que existe SÓLO en un fondo, sin la base, que es un hueco igual. */
test('el panel cuenta HUECOS y no filas: una carta en tres fondos es un hueco', async () => {
  const adminToken = await register(ADMIN)
  const markCard = (cardKey) =>
    app.inject({ method: 'PUT', url: `/api/cartas/${cardKey}`, headers: auth(adminToken), payload: { cantidad: 1 } })

  await markCard('ley-6:824')       // la base
  await markCard('ley-6-dor:824')   // el mismo hueco, en dorado
  await markCard('ley-6-pla:824')   // el mismo hueco, en plata
  await markCard('ley-6-cya:900')   // un hueco que sólo tenés en un fondo: la base no está
  await markCard('exp-1:5')         // y una de la otra colección, sin variantes

  const cols = encodeURIComponent(JSON.stringify({ cromeros: ['exp-1'], leyenda: ['ley-6'] }))
  const r = await app.inject({ method: 'GET', url: `/api/admin/resumen?cols=${cols}`, headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  const ownByCollection = d.gente.find((g) => g.usuario === ADMIN).porColeccion
  assert.equal(ownByCollection.leyenda.cartas, 4, 'son cuatro FILAS: la base, dos fondos y la 900 en cyan')
  assert.equal(ownByCollection.leyenda.huecos, 2,
    'pero DOS huecos: la 824 —esté en los fondos que esté— y la 900')
  assert.equal(ownByCollection.cromeros.cartas, 1)
  assert.equal(ownByCollection.cromeros.huecos, 1, 'sin variantes, una fila es un hueco')

  /* Y el total por colección tiene que sumar lo mismo, o el panel se contradice consigo. */
  const leyendaTotals = d.porColeccion.find((c) => c.col === 'leyenda')
  assert.equal(leyendaTotals.cartas, 4)
  assert.equal(leyendaTotals.huecos, 2)

  /* LA PRUEBA DE QUE EL BUG ESTÁ ARREGLADO: contra 1097 huecos, las filas darían más que
     los huecos. Con un álbum chico se ve en el porcentaje mismo. */
  assert.ok(ownByCollection.leyenda.huecos < ownByCollection.leyenda.cartas,
    'si esto no se cumple es que se están contando filas otra vez')
})

/* #81. `volvieron` es EL número del panel: la pregunta no es cuánta gente entra sino
   cuánta vuelve. Es además el que ya estuvo mal una vez —se contaba con `sesion`, que
   dura 30 días, y el que entraba una vez y usaba la app todos los días figuraba como
   que no había vuelto nunca— y aun así no tenía ningún test. Acá se siembran visitas a
   mano, que es la única forma de tener días distintos sin esperar a mañana. */
test('volvieron cuenta días distintos, no sesiones ni pedidos', async () => {
  const adminToken = await register(ADMIN)
  const returningToken = await register('vuelve@ejemplo.com')
  const oneTimeToken = await register('unavez@ejemplo.com')
  assert.ok(returningToken && oneTimeToken)

  const ids = {}
  const [rows] = await pool.query('SELECT id, usuario FROM usuario')
  for (const f of rows) ids[f.usuario] = f.id

  await pool.query('DELETE FROM visita')
  const today = todayInArgentina()
  await pool.query(
    'INSERT INTO visita (usuario_id, dia) VALUES (?, ?), (?, DATE_SUB(?, INTERVAL 1 DAY)), (?, ?)',
    [ids['vuelve@ejemplo.com'], today, ids['vuelve@ejemplo.com'], today, ids['unavez@ejemplo.com'], today]
  )
  // Y muchos pedidos del mismo día NO tienen que sumar: es el error que tuvo el panel.
  for (let i = 0; i < 5; i++)
    await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(oneTimeToken) })

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()
  assert.equal(d.usuarios.volvieron, 1, 'sólo uno entró en dos días distintos')

  const returningRow = d.gente.find((g) => g.usuario === 'vuelve@ejemplo.com')
  assert.equal(returningRow.dias, 2, 'y su columna de días tiene que decir 2')
  assert.equal(d.gente.find((g) => g.usuario === 'unavez@ejemplo.com').dias, 1)
})

/* #60. El total del catálogo era un 1936 escrito a mano acá adentro, y el catálogo vive
   en el front y se edita sin recompilar. Ya no se manda: que el panel lo saque de donde
   está la verdad. Si alguien lo vuelve a agregar, que este test lo frene. */
test('el resumen ya no manda el tamaño del catálogo, que no es suyo', async () => {
  const adminToken = await register(ADMIN)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(adminToken) })
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
  const adminToken = await register(ADMIN)
  await pool.query('DELETE FROM usuario WHERE usuario <> ?', [ADMIN])

  const today = todayInArgentina()
  const seed = [
    ['justo-afuera@ejemplo.com', 7, '23:30:00'],  // último minuto del día que queda afuera
    ['justo-adentro@ejemplo.com', 6, '00:30:00'], // primer minuto del día que entra
    ['anteayer@ejemplo.com', 2, '12:00:00'],
  ]
  for (const [user, daysAgo, time] of seed) {
    await pool.query(
      `INSERT INTO usuario (usuario, hash, creado)
       VALUES (?, 'x', CONVERT_TZ(CONCAT(DATE_SUB(?, INTERVAL ? DAY), ' ', ?), '-03:00', '+00:00'))`,
      [user, today, daysAgo, time]
    )
  }

  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(adminToken) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  // El admin se registró recién, así que entra; el de hace 7 días no, aunque sea 23:30.
  assert.equal(d.usuarios.altas7, 3,
    'tienen que entrar el admin, el de hace 6 días y el de hace 2 — y NO el de hace 7')

  // Y el gráfico tiene que cuadrar con ese número: los dos miden días locales.
  const windowStart = new Date(`${today}T00:00:00Z`)
  windowStart.setUTCDate(windowStart.getUTCDate() - 6)
  const cutoff = windowStart.toISOString().slice(0, 10)
  const inLastSevenDays = d.porDia.filter((x) => x.dia >= cutoff).reduce((a, x) => a + x.cuantos, 0)
  assert.equal(inLastSevenDays, d.usuarios.altas7,
    'el gráfico y el contador tienen que dar lo mismo: antes usaban ventanas distintas')

  // El de hace 7 días existe, pero cae fuera de la ventana: no es que se haya perdido.
  assert.equal(d.usuarios.total, 4)
})
