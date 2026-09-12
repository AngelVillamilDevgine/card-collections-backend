// La API. Cada pedido de cartas pasa por `conSesion`, así que no hay forma de leer
// ni tocar la colección de otro: el usuario_id sale del token, nunca de la URL.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, borrarVencidas } from './base.js'
import {
  hashearClave, claveCoincide, crearSesion, cerrarSesion,
  usuarioDeToken, revisarCredenciales, tokenDe,
} from './auth.js'
import { leer, guardarCarta, reemplazar, revisarCarta, claveValida } from './coleccion.js'

const PUERTO = Number(process.env.PORT ?? 8787)
const DIRECCION = process.env.DBZ_DIRECCION ?? '127.0.0.1'

// En producción el front vive en otro dominio (Cloudflare), así que hay que decir
// cuáles pueden pedirle a esta API. Sin esto el navegador corta el pedido.
const ORIGENES = (process.env.DBZ_ORIGENES ?? 'http://localhost:5173')
  .split(',').map((o) => o.trim()).filter(Boolean)

export function crearApp(base) {
  const app = Fastify({
    // Va detrás de un proxy (Caddy/nginx): sin esto, la IP de todos sería la del proxy
    // y el freno de intentos de abajo sería uno solo para el mundo entero.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    logger: { level: process.env.DBZ_LOG ?? 'info' },
  })

  app.register(cors, { origin: ORIGENES, credentials: false })

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
  setInterval(() => {
    for (const [ip, v] of intentos) if (Date.now() - v.desde > VENTANA) intentos.delete(ip)
  }, VENTANA).unref()

  /* --- Sesión ---------------------------------------------------------------- */

  function conSesion(pedido, respuesta, seguir) {
    const usuario = usuarioDeToken(base, tokenDe(pedido))
    if (!usuario) return respuesta.code(401).send({ error: 'Tenés que entrar de nuevo.' })
    pedido.usuario = usuario
    seguir()
  }

  app.post('/api/registro', async (pedido, respuesta) => {
    const { usuario, clave } = pedido.body ?? {}
    const mal = revisarCredenciales(usuario, clave)
    if (mal) return respuesta.code(400).send({ error: mal })

    const existe = base.prepare('SELECT 1 FROM usuario WHERE usuario = ?').get(usuario)
    if (existe) return respuesta.code(409).send({ error: 'Ese usuario ya está tomado.' })

    const { lastInsertRowid: id } = base
      .prepare('INSERT INTO usuario (usuario, hash) VALUES (?, ?)')
      .run(usuario, await hashearClave(clave))

    return { token: crearSesion(base, id), usuario }
  })

  app.post('/api/sesion', async (pedido, respuesta) => {
    if (frenado(pedido.ip))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })

    const { usuario, clave } = pedido.body ?? {}
    const fila = typeof usuario === 'string'
      ? base.prepare('SELECT id, usuario, hash FROM usuario WHERE usuario = ?').get(usuario)
      : null

    // El mismo mensaje exista o no el usuario: si no, se puede averiguar quién está
    // registrado probando nombres.
    const negar = () => respuesta.code(401).send({ error: 'Usuario o clave incorrectos.' })
    if (!fila || typeof clave !== 'string') return negar()
    if (!await claveCoincide(clave, fila.hash)) return negar()

    perdonar(pedido.ip)
    return { token: crearSesion(base, fila.id), usuario: fila.usuario }
  })

  app.delete('/api/sesion', { preHandler: conSesion }, async (pedido) => {
    cerrarSesion(base, tokenDe(pedido))
    return { chau: true }
  })

  app.get('/api/yo', { preHandler: conSesion }, async (pedido) => ({
    usuario: pedido.usuario.usuario,
  }))

  /* --- Colección ------------------------------------------------------------- */

  app.get('/api/coleccion', { preHandler: conSesion }, async (pedido) =>
    leer(base, pedido.usuario.id))

  // El camino caliente: un toque en una carta manda sólo esa carta.
  app.put('/api/cartas/:clave', { preHandler: conSesion }, async (pedido, respuesta) => {
    const { clave } = pedido.params
    if (!claveValida(clave)) return respuesta.code(400).send({ error: 'Clave inválida.' })

    const mal = revisarCarta(pedido.body)
    if (mal) return respuesta.code(400).send({ error: mal })

    guardarCarta(base, pedido.usuario.id, clave, pedido.body.cantidad, pedido.body.estado)
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
    return { cartas: reemplazar(base, pedido.usuario.id, { estados, cantidades }) }
  })

  /* --- Para el deploy: si esto no contesta, la versión nueva no sirve. --------- */
  app.get('/api/salud', async () => {
    base.prepare('SELECT 1').get()
    return { bien: true, version: process.env.DBZ_VERSION ?? 'dev' }
  })

  return app
}

/* Sólo arranca si lo corrés directo, no si lo importa un test. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = abrir()
  borrarVencidas(base)
  setInterval(() => borrarVencidas(base), 24 * 60 * 60 * 1000).unref()

  const app = crearApp(base)
  app.listen({ port: PUERTO, host: DIRECCION })
    .then(() => app.log.info(`origenes permitidos: ${ORIGENES.join(', ')}`))
    .catch((e) => { app.log.error(e); process.exit(1) })

  // systemd manda SIGTERM al reiniciar: cerrar prolijo evita dejar el WAL a medias.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.on(senal, () => app.close().then(() => { base.close(); process.exit(0) }))
  }
}
