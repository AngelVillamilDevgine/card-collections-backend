// La API. Cada pedido de cartas pasa por `conSesion`, así que no hay forma de leer
// ni tocar la colección de otro: el usuario_id sale del token, nunca de la URL.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { conectar, prepararEsquema, borrarVencidas } from './base.js'
import {
  hashearClave, claveCoincide, crearSesion, cerrarSesion,
  usuarioDeToken, revisarCredenciales, tokenDe,
} from './auth.js'
import { leer, guardarCarta, reemplazar, revisarCarta, claveValida } from './coleccion.js'
import { anotarVisita, resumen } from './estadisticas.js'

const PUERTO = Number(process.env.PORT ?? 8787)
// En Docker hay que escuchar en todas las interfaces o Traefik no llega al contenedor.
const DIRECCION = process.env.DBZ_DIRECCION ?? '0.0.0.0'

// El front vive en otro dominio (Cloudflare), así que hay que decir cuáles pueden
// pedirle a esta API. Sin esto el navegador corta el pedido.
/* Quién ve las estadísticas. Por variable y no por una columna en la base: hay un solo
   admin, y así se saca a alguien sin tocar datos. */
const ADMINS = (process.env.DBZ_ADMINS ?? '')
  .split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)

const ORIGENES = (process.env.DBZ_ORIGENES ?? 'http://localhost:5173')
  .split(',').map((o) => o.trim()).filter(Boolean)

const esAdmin = (usuario) => ADMINS.includes(String(usuario).toLowerCase())

export function crearApp(pool) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: { level: process.env.DBZ_LOG ?? 'info' },
  })

  app.register(cors, { origin: ORIGENES, credentials: false })

  /* --- Freno a la fuerza bruta -------------------------------------------------
     Sin esto, probar claves contra /sesion sale gratis. Se cuenta por IP y se
     olvida solo; alcanza para lo que es, y no agrega ni una dependencia. */

  /* De dónde sale la IP del cliente, que es la clave del balde.

     Antes esto era `trustProxy: true` y `pedido.ip`. Fastify, con esa opción, toma el
     valor más a la IZQUIERDA de `X-Forwarded-For`, que es exactamente el que pone el
     cliente: con una cabecera distinta en cada pedido, cada intento estrenaba su propio
     contador y el tope no existía.

     Por el camino normal eso hoy no se puede explotar, porque Cloudflare reescribe esa
     cabecera y descarta lo que haya mandado el cliente — se verificó contra producción:
     doce intentos con la misma IP falsa activaron el freno, y seis con IPs distintas
     dieron 429 igual. Pero el origen es alcanzable directo por el 443, y por ahí sí la
     controlaría el atacante.

     Así que se usa `CF-Connecting-IP`, que la pone Cloudflare y pisa cualquier valor del
     cliente. Si no está, se cae al socket, que detrás de Traefik es el mismo para todos:
     eso falla CERRADO — quien le pegue directo al origen comparte un solo balde con
     todos los demás que hagan lo mismo. */
  const ipDe = (pedido) => {
    const cf = pedido.headers['cf-connecting-ip']
    return (typeof cf === 'string' && cf.trim()) || pedido.ip
  }

  const intentos = new Map()
  const TOPE = 10
  const VENTANA = 15 * 60 * 1000

  function frenado(ip) {
    const previo = intentos.get(ip)
    if (!previo || Date.now() - previo.desde > VENTANA) {
      intentos.set(ip, { n: 1, desde: Date.now() })
      return false
    }
    previo.n++
    return previo.n > TOPE
  }
  const perdonar = (ip) => intentos.delete(ip)
  const reloj = setInterval(() => {
    for (const [ip, v] of intentos) if (Date.now() - v.desde > VENTANA) intentos.delete(ip)
  }, VENTANA)
  reloj.unref()
  app.addHook('onClose', () => clearInterval(reloj))

  /* --- Sesión ---------------------------------------------------------------- */

  async function conSesion(pedido, respuesta) {
    const usuario = await usuarioDeToken(pool, tokenDe(pedido))
    if (!usuario) return respuesta.code(401).send({ error: 'Tenés que entrar de nuevo.' })
    pedido.usuario = usuario
    // `?app=1` lo manda el front cuando corre como app instalada. Va en la dirección y
    // no en una cabecera para no obligar a un pedido de permiso previo.
    anotarVisita(pool, usuario.id, pedido.query?.app === '1') // una vez por día, sin esperarla
  }

  app.post('/api/registro', async (pedido, respuesta) => {
    /* El mismo freno que /sesion, que acá faltaba. Cada pedido corre un scrypt —16 MB
       y ~100 ms de CPU, con 0.5 disponibles en el contenedor—, así que un bucle trivial
       saturaba el threadpool y frenaba TODA la API, incluido /api/salud: con el
       healthcheck en rojo, Docker mata y reinicia la tarea. Y de paso llenaba la tabla
       de cuentas basura. */
    if (frenado(ipDe(pedido)))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })

    const { usuario, clave } = pedido.body ?? {}
    const mal = revisarCredenciales(usuario, clave)
    if (mal) return respuesta.code(400).send({ error: mal })

    /* Mirar antes de hashear. El scrypt se evaluaba como argumento del INSERT, o sea
       que se pagaba entero aunque el usuario ya existiera y el UNIQUE fuera a rechazar
       la fila igual. El UNIQUE sigue siendo el que decide —dos registros simultáneos
       con el mismo nombre los resuelve la base, no este SELECT, que puede quedar viejo
       entre medio—; esto sólo evita pagar el scrypt por cada intento repetido. */
    const [ya] = await pool.query('SELECT 1 FROM usuario WHERE usuario = ? LIMIT 1', [usuario])
    if (ya.length) return respuesta.code(409).send({ error: 'Ese usuario ya está tomado.' })

    let id
    try {
      const [r] = await pool.query(
        'INSERT INTO usuario (usuario, hash) VALUES (?, ?)',
        [usuario, await hashearClave(clave)]
      )
      id = r.insertId
    } catch (e) {
      // Dos registros a la vez con el mismo nombre: el UNIQUE de la tabla es el que
      // decide, no un SELECT previo que puede quedar viejo entre medio.
      if (e.code === 'ER_DUP_ENTRY')
        return respuesta.code(409).send({ error: 'Ese usuario ya está tomado.' })
      throw e
    }

    anotarVisita(pool, id, pedido.query?.app === '1')
    return { token: await crearSesion(pool, id), usuario, admin: esAdmin(usuario) }
  })

  app.post('/api/sesion', async (pedido, respuesta) => {
    if (frenado(ipDe(pedido)))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })

    const { usuario, clave } = pedido.body ?? {}
    let fila = null
    if (typeof usuario === 'string') {
      const [filas] = await pool.query(
        'SELECT id, usuario, hash FROM usuario WHERE usuario = ?', [usuario]
      )
      fila = filas[0] ?? null
    }

    // El mismo mensaje exista o no el usuario: si no, se puede averiguar quién está
    // registrado probando nombres.
    const negar = () => respuesta.code(401).send({ error: 'Usuario o clave incorrectos.' })
    if (!fila || typeof clave !== 'string') return negar()
    if (!await claveCoincide(clave, fila.hash)) return negar()

    perdonar(ipDe(pedido))
    anotarVisita(pool, fila.id, pedido.query?.app === '1')
    return { token: await crearSesion(pool, fila.id), usuario: fila.usuario, admin: esAdmin(fila.usuario) }
  })

  app.delete('/api/sesion', { preHandler: conSesion }, async (pedido) => {
    await cerrarSesion(pool, tokenDe(pedido))
    return { chau: true }
  })

  app.get('/api/yo', { preHandler: conSesion }, async (pedido) => ({
    usuario: pedido.usuario.usuario,
    admin: esAdmin(pedido.usuario.usuario),
  }))

  /* --- Estadísticas, sólo para el admin ------------------------------------------ */
  app.get('/api/admin/resumen', { preHandler: conSesion }, async (pedido, respuesta) => {
    // 404 y no 403: a quien no es admin no se le confirma que esto existe.
    if (!esAdmin(pedido.usuario.usuario)) return respuesta.code(404).send({ error: 'No existe.' })
    return resumen(pool)
  })

  /* --- Colección ------------------------------------------------------------- */

  app.get('/api/coleccion', { preHandler: conSesion }, async (pedido) =>
    leer(pool, pedido.usuario.id))

  // El camino caliente: un toque en una carta manda sólo esa carta.
  app.put('/api/cartas/:clave', { preHandler: conSesion }, async (pedido, respuesta) => {
    const { clave } = pedido.params
    if (!claveValida(clave)) return respuesta.code(400).send({ error: 'Clave inválida.' })

    const mal = revisarCarta(pedido.body)
    if (mal) return respuesta.code(400).send({ error: mal })

    await guardarCarta(pool, pedido.usuario.id, clave, pedido.body.cantidad, pedido.body.estado)
    return respuesta.code(204).send()
  })

  // La colección entera. La usa "Restaurar una copia", no el uso diario.
  app.put('/api/coleccion', { preHandler: conSesion }, async (pedido, respuesta) => {
    const { estados, cantidades } = pedido.body ?? {}
    if (typeof cantidades !== 'object' || cantidades === null)
      return respuesta.code(400).send({ error: 'Falta "cantidades".' })

    for (const clave of Object.keys(cantidades)) {
      if (!claveValida(clave))
        return respuesta.code(400).send({ error: `Clave inválida: ${clave}` })
    }
    return { cartas: await reemplazar(pool, pedido.usuario.id, { estados, cantidades }) }
  })

  /* --- Para el deploy: si esto no contesta, la versión nueva no sirve. ---------
     Toca la base a propósito: un proceso vivo que no llega al MySQL no sirve. */
  app.get('/api/salud', async (pedido, respuesta) => {
    try {
      await pool.query('SELECT 1')
    } catch {
      return respuesta.code(503).send({ bien: false, error: 'sin base' })
    }
    return { bien: true, version: process.env.DBZ_VERSION ?? 'dev' }
  })

  return app
}

/* Sólo arranca si lo corrés directo, no si lo importa un test. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = conectar()
  await prepararEsquema(pool)
  await borrarVencidas(pool)
  const limpieza = setInterval(() => borrarVencidas(pool).catch(() => {}), 24 * 60 * 60 * 1000)
  limpieza.unref()

  const app = crearApp(pool)
  app.listen({ port: PUERTO, host: DIRECCION })
    .then(() => app.log.info(`origenes permitidos: ${ORIGENES.join(', ')}`))
    .catch((e) => { app.log.error(e); process.exit(1) })

  // Docker manda SIGTERM al reemplazar el contenedor: cerrar prolijo evita cortar
  // un guardado a la mitad.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.on(senal, async () => {
      await app.close()
      await pool.end()
      process.exit(0)
    })
  }
}
