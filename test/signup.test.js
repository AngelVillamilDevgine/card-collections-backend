// Las cuentas basura al registrarse: los mails de prueba no entran, y desde una misma
// conexión no se crean más de tres cuentas por día. Ver src/signup.js.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { olvidarVisitas } from '../src/estadisticas.js'
import { looksLikeTestEmail, networkOf, connectionKey, SIGNUPS_PER_CONNECTION } from '../src/signup.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
let pool
let app
let seq = 0

before(async () => {
  const { crearApp } = await import('../src/servidor.js')
  pool = conectar(URL)
  await prepararEsquema(pool)
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  await app?.close()
  await pool?.end()
})

beforeEach(async () => {
  await pool.query('DELETE FROM usuario')
  olvidarVisitas()
})

const signup = (usuario, ip) => app.inject({
  method: 'POST', url: '/api/registro', payload: { usuario, clave: 'kamehameha' },
  headers: { 'cf-connecting-ip': ip },
})

// ------------------------------------------------------------ los mails de prueba

test('los mails de prueba de siempre no son una cuenta', () => {
  for (const mail of ['test@gmail.com', 'test2@gmail.com', 'TEST@gmail.com', 't.e.s.t@gmail.com', 'test+1@gmail.com',
    'test_3@hotmail.com', 'prueba@gmail.com', 'prueba123@yahoo.com', 'asdf@gmail.com', 'qwerty@gmail.com',
    'demo@gmail.com', 'aaaa@gmail.com', 'xxx@gmail.com', 'asd@hotmail.com', 'angel@example.com', 'alguien@test.com',
    // disfrazados: letras anchas y un espacio invisible
    'ｔｅｓｔ@gmail.com', 'te\u200bst2@gmail.com'])
    assert.equal(looksLikeTestEmail(mail), true, mail)
})

test('un mail de verdad que sólo empieza parecido, pasa', () => {
  for (const mail of ['testarossa@gmail.com', 'contest@gmail.com', 'pruebaonline@gmail.com', 'angelvillamil1234@gmail.com',
    'franhklkk2@gmail.com', 'leonel99cuenta2@gmail.com', 'asdrubal@gmail.com', 'demonio@gmail.com', 'alguien@ejemplo.com.ar',
    // iniciales con el año o una matrícula: la casilla de hotmail de toda la vida
    'aa1985@hotmail.com', 'aa_1979@yahoo.com.ar', 'a.a.1990@gmail.com', 'asd1990@hotmail.com', 'xx1990@hotmail.com',
    'A01234567@tec.mx', 'braian.llanos@mi.unc.edu.ar'])
    assert.equal(looksLikeTestEmail(mail), false, mail)
})

test('registrarse con un mail de prueba: 400 y no se crea nada', async () => {
  const r = await signup('test2@gmail.com', '10.20.0.1')
  assert.equal(r.statusCode, 400)
  assert.match(r.json().error, /prueba/)
  const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM usuario')
  assert.equal(n, 0)
})

// ------------------------------------------------------------ tres por conexión

test(`desde una misma conexión, ${SIGNUPS_PER_CONNECTION} cuentas por día y no más`, async () => {
  for (let i = 1; i <= SIGNUPS_PER_CONNECTION; i++)
    assert.equal((await signup(`hermano${i}@gmail.com`, '10.20.1.1')).statusCode, 200, `la ${i}`)
  const otra = await signup('otro@gmail.com', '10.20.1.1')
  assert.equal(otra.statusCode, 429)
  assert.match(otra.json().error, /esta conexión/)
  // Otra conexión, sin problema.
  assert.equal((await signup('vecino@gmail.com', '10.20.1.2')).statusCode, 200)
})

test('lo de hace más de un día ya no cuenta', async () => {
  for (let i = 1; i <= SIGNUPS_PER_CONNECTION; i++) await signup(`viejo${i}@gmail.com`, '10.20.2.1')
  await pool.query('UPDATE usuario SET creado = NOW() - INTERVAL 25 HOUR')
  assert.equal((await signup('nuevo@gmail.com', '10.20.2.1')).statusCode, 200)
})

test('en IPv6 cuenta la red /64: estrenar dirección no estrena tope', async () => {
  for (let i = 1; i <= SIGNUPS_PER_CONNECTION; i++)
    assert.equal((await signup(`seis${i}@gmail.com`, `2800:810:4a5:1::${i}`)).statusCode, 200)
  assert.equal((await signup('seis9@gmail.com', '2800:810:4a5:1:abcd:ef01:2345:6789')).statusCode, 429)
  assert.equal((await signup('seisotra@gmail.com', '2800:810:4a5:2::1')).statusCode, 200) // otra /64
})

test('se guarda un HMAC de la conexión, nunca la IP', async () => {
  await signup('privado@gmail.com', '181.45.67.89')
  const [[row]] = await pool.query('SELECT signup_net FROM usuario WHERE usuario = ?', ['privado@gmail.com'])
  assert.match(row.signup_net, /^[0-9a-f]{64}$/)
  assert.ok(!row.signup_net.includes('181'), 'la IP no puede aparecer')
})

test('la red de una IP: IPv4 entera, IPv6 en /64 escrita siempre igual', () => {
  assert.equal(networkOf('181.45.67.89'), '181.45.67.89')
  assert.equal(networkOf('::ffff:181.45.67.89'), '181.45.67.89')
  assert.equal(networkOf('2800:810:4a5:1::7'), '2800:0810:04a5:0001::/64')
  assert.equal(networkOf('2800:0810:04A5:0001:aaaa:bbbb:cccc:dddd'), '2800:0810:04a5:0001::/64')
  assert.equal(networkOf('2800::1'), '2800:0000:0000:0000::/64')
  assert.equal(connectionKey('2800:810:4a5:1::7', 's'), connectionKey('2800:810:4a5:1:ffff::', 's'))
  assert.notEqual(connectionKey('181.45.67.89', 'a'), connectionKey('181.45.67.89', 'b')) // sin la clave no se compara
})

/* La carrera que encontró la revisión: contar y después insertar dejaba pasar a todas las
   que llegaban juntas (diez desde una IP, cuarenta desde una /64). */
test('las altas que llegan JUNTAS desde una conexión también son tres', async () => {
  const extra = SIGNUPS_PER_CONNECTION + 4
  const juntas = await Promise.all(Array.from({ length: extra }, (_, i) => signup(`juntas${i}@gmail.com`, '10.20.3.1')))
  assert.equal(juntas.filter((r) => r.statusCode === 200).length, SIGNUPS_PER_CONNECTION)
  assert.equal(juntas.filter((r) => r.statusCode === 429).length, extra - SIGNUPS_PER_CONNECTION)
  const seis = await Promise.all(Array.from({ length: extra }, (_, i) => signup(`seisjuntas${i}@gmail.com`, `2800:810:4a5:9::${i + 1}`)))
  assert.equal(seis.filter((r) => r.statusCode === 200).length, SIGNUPS_PER_CONNECTION)
  const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM usuario')
  assert.equal(n, 2 * SIGNUPS_PER_CONNECTION)
})
