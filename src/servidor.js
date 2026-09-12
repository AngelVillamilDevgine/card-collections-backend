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
import fs from 'node:fs'
import crypto from 'node:crypto'

/* El secreto llega como secret del swarm (un archivo) o como variable, para local. */
function leerSecreto() {
  const archivo = process.env.DBZ_SECRETO_PROXY_FILE
  if (archivo) return fs.readFileSync(archivo, 'utf8').trim()
  return process.env.DBZ_SECRETO_PROXY ?? null
}

/* Comparar con === diría por el tiempo cuántos caracteres acertó quien prueba. */
function igualesSinFiltrarTiempo(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const PUERTO = Number(process.env.PORT ?? 8787)
// En Docker hay que escuchar en todas las interfaces o Traefik no llega al contenedor.
const DIRECCION = process.env.DBZ_DIRECCION ?? '0.0.0.0'

// El front vive en otro dominio (Cloudflare), así que hay que decir cuáles pueden
// pedirle a esta API. Sin esto el navegador corta el pedido.
const ORIGENES = (process.env.DBZ_ORIGENES ?? 'http://localhost:5173')
  .split(',').map((o) => o.trim()).filter(Boolean)

export function crearApp(pool) {
  const app = Fastify({
    // Va detrás de Traefik: sin esto, la IP de todos sería la del proxy y el freno
    // de intentos de abajo sería uno solo para el mundo entero.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    logger: { level: process.env.DBZ_LOG ?? 'info' },
  })

  app.register(cors, { origin: ORIGENES, credentials: false })

  /* --- El portero ---------------------------------------------------------------
     Esta API está publicada en un puerto propio del VPS porque quien le habla es una
     Function de Cloudflare Pages, que no puede llegarle por Traefik (haría falta un
     dominio que hoy no tenemos). Un puerto abierto lo encuentra cualquier escáner en
     horas, así que sin esta cabecera no se pasa de acá.

     OJO: esto autentica a la Function, no cifra nada. El tramo va en claro; es la
     decisión que se tomó a sabiendas. Ver el README. */
  const SECRETO = leerSecreto()

  if (SECRETO) {
    app.addHook('onRequest', async (pedido, respuesta) => {
      // /api/salud queda afuera: lo consulta el healthcheck del contenedor y no
      // devuelve nada que no se pueda ver.
      if (pedido.url.startsWith('/api/salud')) return
      const dado = pedido.headers['x-dbz-proxy']
      if (!dado || !igualesSinFiltrarTiempo(dado, SECRETO)) {
        return respuesta.code(404).send({ error: 'No existe.' })
      }
    })
  }

  /* --- Freno a la fuerza bruta -------------------------------------------------
     Sin esto, probar claves contra /sesion sale gratis. Se cuenta por IP y se
     olvida solo; alcanza para lo que es, y no agrega ni una dependencia. */
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
  }

  app.post('/api/registro', async (pedido, respuesta) => {
    const { usuario, clave } = pedido.body ?? {}
    const mal = revisarCredenciales(usuario, clave)
    if (mal) return respuesta.code(400).send({ error: mal })

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

    return { token: await crearSesion(pool, id), usuario }
  })

  app.post('/api/sesion', async (pedido, respuesta) => {
    if (frenado(pedido.ip))
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

    perdonar(pedido.ip)
    return { token: await crearSesion(pool, fila.id), usuario: fila.usuario }
  })

  app.delete('/api/sesion', { preHandler: conSesion }, async (pedido) => {
    await cerrarSesion(pool, tokenDe(pedido))
    return { chau: true }
  })

  app.get('/api/yo', { preHandler: conSesion }, async (pedido) => ({
    usuario: pedido.usuario.usuario,
  }))

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
