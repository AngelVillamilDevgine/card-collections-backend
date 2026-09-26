// La API. Cada pedido de cartas pasa por `conSesion`, así que no hay forma de leer
// ni tocar la colección de otro: el usuario_id sale del token, nunca de la URL.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { conectar, conectarSalud, prepararEsquema, borrarVencidas } from './base.js'
import {
  hashearClave, claveCoincide, crearSesion, cerrarSesion,
  usuarioDeToken, revisarCredenciales, tokenDe, gastarComoSiExistiera,
  cambiarClave, cerrarLasDemas,
} from './auth.js'
import { leer, guardarCarta, reemplazar, revisarCarta, revisarReemplazo, claveValida } from './coleccion.js'
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

export function crearApp(pool, poolSalud = pool) {
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

     Así que se usa `CF-Connecting-IP`. Por el camino normal no se puede falsificar, y
     por una razón más fuerte que "Cloudflare la pisa": **Cloudflare rechaza con 403, en
     el borde, cualquier pedido que traiga una cabecera CF-* puesta por el cliente**. Se
     comprobó contra producción — doce intentos con CF-Connecting-IP inventada dieron los
     doce 403 y no llegaron nunca al origen.

     Si no está, se cae al socket, que detrás de Traefik es el mismo para todos: eso falla
     CERRADO, porque quien le pegue directo al origen sin la cabecera comparte un solo
     balde con todos los que hagan lo mismo.

     LO QUE ESTO NO CIERRA, para que quede escrito: quien le pegue **directo al origen**
     por el 443 (que pasa la lista blanca de Dattaweb) y encima se invente la cabecera,
     sigue estrenando contador. Cerrarlo del todo es de red, no de esta app: que al
     origen sólo lleguen los rangos de Cloudflare. Está anotado como hallazgo aparte. */
  const ipDe = (pedido) => {
    const cf = pedido.headers['cf-connecting-ip']
    return (typeof cf === 'string' && cf.trim()) || pedido.ip
  }

  /* El balde cuenta FRACASOS, no intentos, y bajo dos llaves a la vez:

       ip|usuario -> el que le pega a UNA cuenta
       ip         -> el que prueba la misma clave en muchas cuentas

     Un login bueno perdona sólo la primera; la de la IP no se toca. Antes se contaban
     todos los intentos y `perdonar` borraba el balde entero de la IP, así que el
     atacante se registraba una cuenta propia y la usaba de botón de reinicio: diez tiros
     a la víctima, uno bueno a la suya, y a empezar de nuevo. Eso no lo tapaba ninguna de
     las otras defensas. */
  const TOPE_CUENTA = 10      // fracasos contra una misma cuenta
  const TOPE_IP = 20          // fracasos desde una misma IP, contra las cuentas que sean
  const TOPE_REGISTROS = 10   // registros desde una misma IP, salgan bien o mal
  const VENTANA = 15 * 60 * 1000

  /* Cuántos baldes se guardan como mucho. La llave la arma en parte el cliente —la IP y
     el nombre de usuario que manda—, así que sin tope se puede hacer crecer el Map hasta
     voltear el proceso, que tiene 256 MB. Cuando se llena se tiran los más viejos y no
     todos: un `clear()` le daría al atacante justo lo que busca, una forma de borrar los
     contadores de los demás. */
  const MAXIMO_BALDES = 5000

  const intentos = new Map()

  function balde(llave) {
    const previo = intentos.get(llave)
    if (previo && Date.now() - previo.desde <= VENTANA) return previo
    if (intentos.size >= MAXIMO_BALDES) {
      for (const vieja of intentos.keys()) {
        intentos.delete(vieja)
        if (intentos.size < MAXIMO_BALDES * 0.9) break
      }
    }
    const nuevo = { n: 0, desde: Date.now() }
    intentos.set(llave, nuevo)
    return nuevo
  }

  const frenado = (llave, tope) => balde(llave).n >= tope
  const sumar = (llave) => { balde(llave).n++ }
  const perdonar = (llave) => intentos.delete(llave)

  const reloj = setInterval(() => {
    for (const [llave, v] of intentos) if (Date.now() - v.desde > VENTANA) intentos.delete(llave)
  }, VENTANA)
  reloj.unref()
  app.addHook('onClose', () => clearInterval(reloj))

  /* HSTS también en la API, y no sólo en el front.

     La cabecera es POR HOST: la que manda cromeros.com.ar no cubre a
     api.cromeros.com.ar. Y acá importa igual o más, porque por esta puerta viajan el
     token de sesión en cada pedido y la clave al entrar. La primera visita es la única
     ventana que esto cierra —el `http://` que el navegador intenta antes de que lo
     redirijan—, pero es la ventana donde quien esté en el medio se lleva todo.

     Sin `preload` y sin `includeSubDomains`, por las mismas razones que en el `_headers`
     del front: las dos son puertas de una sola dirección y ninguna hace falta para tener
     el beneficio. */
  app.addHook('onRequest', async (pedido, respuesta) => {
    respuesta.header('Strict-Transport-Security', 'max-age=31536000')
  })

  /* --- Sesión ---------------------------------------------------------------- */

  async function conSesion(pedido, respuesta) {
    const usuario = await usuarioDeToken(pool, tokenDe(pedido))
    if (!usuario) return respuesta.code(401).send({ error: 'Tenés que entrar de nuevo.' })
    pedido.usuario = usuario
    // `?app=1` lo manda el front cuando corre como app instalada. Va en la dirección y
    // no en una cabecera para no obligar a un pedido de permiso previo.
    /* Abrir el panel de números NO cuenta como usar la app: se anotaba tu visita del
       día ANTES de calcular nada, así que "la usaron hoy" y tu propia retención se
       inflaban con tus propios chequeos. Con 28 cuentas, mirar el panel todos los días
       era una parte medible del número que el panel existe para mostrar. */
    if (pedido.routeOptions?.url !== '/api/admin/resumen')
      anotarVisita(pool, usuario.id, pedido.query?.app === '1') // una vez por día, sin esperarla
  }

  app.post('/api/registro', async (pedido, respuesta) => {
    /* El mismo freno que /sesion, que acá faltaba. Cada pedido corre un scrypt —16 MB
       y ~100 ms de CPU, con 0.5 disponibles en el contenedor—, así que un bucle trivial
       saturaba el threadpool y frenaba TODA la API, incluido /api/salud: con el
       healthcheck en rojo, Docker mata y reinicia la tarea. Y de paso llenaba la tabla
       de cuentas basura. */
    const llave = `reg|${ipDe(pedido)}`
    if (frenado(llave, TOPE_REGISTROS))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })
    // Cuentan todos, salgan bien o mal: lo que se limita acá es crear cuentas.
    sumar(llave)

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
    const ip = ipDe(pedido)
    const { usuario, clave } = pedido.body ?? {}
    // Minúsculas porque la colación de la base tampoco distingue: si no, cambiando una
    // mayúscula se estrenaría contador contra la misma cuenta.
    const suya = `${ip}|${typeof usuario === 'string' ? usuario.toLowerCase() : ''}`

    if (frenado(suya, TOPE_CUENTA) || frenado(ip, TOPE_IP))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })

    let fila = null
    if (typeof usuario === 'string') {
      const [filas] = await pool.query(
        'SELECT id, usuario, hash FROM usuario WHERE usuario = ?', [usuario]
      )
      fila = filas[0] ?? null
    }

    // El mismo mensaje exista o no el usuario: si no, se puede averiguar quién está
    // registrado probando nombres.
    const negar = () => {
      sumar(suya)
      sumar(ip)
      return respuesta.code(401).send({ error: 'Usuario o clave incorrectos.' })
    }

    /* Si el usuario no existe se gasta igual un scrypt contra un hash de descarte. Sin
       eso, negarle a uno inexistente vuelve al instante y a uno real recién después del
       hash: midiendo el tiempo se arma la lista de quién tiene cuenta, que es justo lo
       que el mensaje único intenta evitar. */
    if (!fila || typeof clave !== 'string') {
      await gastarComoSiExistiera(clave)
      return negar()
    }
    if (!await claveCoincide(clave, fila.hash)) return negar()

    // Sólo el balde de ESTA cuenta. El de la IP no se toca: si no, entrar a una cuenta
    // propia serviría de botón de reinicio para seguir probando contra las ajenas.
    perdonar(suya)
    anotarVisita(pool, fila.id, pedido.query?.app === '1')
    return { token: await crearSesion(pool, fila.id), usuario: fila.usuario, admin: esAdmin(fila.usuario) }
  })

  app.delete('/api/sesion', { preHandler: conSesion }, async (pedido) => {
    await cerrarSesion(pool, tokenDe(pedido))
    return { chau: true }
  })

  /* Cambiar la clave, que también echa a todas las demás sesiones.

     Sin esto, a quien le robaban el token o le adivinaban la clave no tenía NADA que
     hacer: la sesión ajena vive 30 días y no había forma de cortarla ni de cambiar nada.
     La única salida era escribirle a Angel para que borrara filas a mano.

     Las dos mitades van juntas a propósito. Cambiar la clave y dejar vivas las sesiones
     abiertas no echa a nadie —el token no sabe nada de la clave—, y cerrar sesiones sin
     cambiar la clave deja entrar de nuevo al que la sabe. Por separado, cada mitad da una
     falsa sensación de haber resuelto algo.

     La sesión que hace el pedido sobrevive: si se cerraran todas, el dueño quedaría
     afuera por cuidarse. */
  app.put('/api/clave', { preHandler: conSesion }, async (pedido, respuesta) => {
    /* Con freno, y por cuenta. Acá el atacante YA tiene el token —si no, no llega—, así
       que no está adivinando desde cero; pero sin freno esto es un oráculo cómodo para
       probar la clave actual sin que el usuario se entere de nada. */
    const llave = `clave|${pedido.usuario.id}`
    if (frenado(llave, TOPE_CUENTA))
      return respuesta.code(429).send({ error: 'Demasiados intentos. Probá en un rato.' })

    const { actual, nueva } = pedido.body ?? {}
    if (typeof actual !== 'string' || !actual)
      return respuesta.code(400).send({ error: 'Falta tu clave actual.' })

    // La nueva pasa por la misma validación que al registrarse: el usuario ya está, así
    // que se revisa con el suyo.
    const mal = revisarCredenciales(pedido.usuario.usuario, nueva)
    if (mal) return respuesta.code(400).send({ error: mal })
    if (nueva === actual)
      return respuesta.code(400).send({ error: 'La clave nueva tiene que ser distinta.' })

    if (!(await cambiarClave(pool, pedido.usuario.id, actual, nueva))) {
      sumar(llave)
      return respuesta.code(401).send({ error: 'Tu clave actual no es esa.' })
    }
    perdonar(llave)

    const echadas = await cerrarLasDemas(pool, pedido.usuario.id, tokenDe(pedido))
    return { echadas }
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

    /* Las tres guardas del reemplazo viven en `coleccion.js` y no acá, aunque esta ruta
       sea la única que las usaba: `bin/importar.js` llama a `reemplazar()` directo, sin
       pasar por HTTP, y por eso no tenía NINGUNA de las tres. Ver `revisarReemplazo`. */
    const mal = revisarReemplazo({ estados, cantidades })
    if (mal) return respuesta.code(400).send({ error: mal })

    return { cartas: await reemplazar(pool, pedido.usuario.id, { estados, cantidades }) }
  })

  /* --- Para el deploy: si esto no contesta, la versión nueva no sirve. ---------
     Toca la base a propósito: un proceso vivo que no llega al MySQL no sirve.

     Pero por un pool APARTE, de una conexión. Este endpoint decide si el swarm mata la
     tarea, y no puede decidirlo con la cola que llenó el propio tráfico: con diez
     reemplazos simultáneos quedaba esperando turno, el swarm lo daba por muerto y
     reiniciaba justo cuando más carga había. En los tests no hay pool aparte y usa el
     mismo, que es lo que corresponde ahí. */
  app.get('/api/salud', async (pedido, respuesta) => {
    try {
      await poolSalud.query('SELECT 1')
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
  const poolSalud = conectarSalud()

  /* Reintentar con espera creciente en vez de morir.

     Antes esto era un `await prepararEsquema(pool)` pelado: si el MySQL no estaba —se
     reinició el contenedor, se quedó sin disco, tardó en levantar— el proceso salía, el
     `restart_policy: on-failure` del stack lo volvía a levantar a los 5 segundos, y otra
     vez. Un bucle de reinicio cada 5 segundos contra una base caída no ayuda a que la
     base vuelva: la castiga, llena el log y no deja ninguna pista de qué pasó.

     Ahora espera. Y si después de todos los intentos sigue sin base, ARRANCA IGUAL: con
     `/api/salud` devolviendo 503, que es la verdad, y cada pedido fallando rápido en vez
     de un proceso que nace y muere. El swarm decide con el healthcheck, que para eso
     está, y nosotros dejamos el motivo escrito en el log una sola vez. */
  const ESPERAS = [2000, 5000, 10000, 20000, 30000]
  let listo = false
  for (let i = 0; i <= ESPERAS.length; i++) {
    try { await prepararEsquema(pool); listo = true; break } catch (e) {
      const ultima = i === ESPERAS.length
      console.error(`[arranque] no pude preparar el esquema (intento ${i + 1}): ${e.message}`)
      if (ultima) break
      await new Promise((r) => setTimeout(r, ESPERAS[i]))
    }
  }
  if (!listo)
    console.error('[arranque] arranco igual, sin base: /api/salud va a contestar 503 hasta que vuelva')

  await borrarVencidas(pool).catch(() => {})
  const limpieza = setInterval(() => borrarVencidas(pool).catch(() => {}), 24 * 60 * 60 * 1000)
  limpieza.unref()

  const app = crearApp(pool, poolSalud)
  app.listen({ port: PUERTO, host: DIRECCION })
    .then(() => app.log.info(`origenes permitidos: ${ORIGENES.join(', ')}`))
    .catch((e) => { app.log.error(e); process.exit(1) })

  // Docker manda SIGTERM al reemplazar el contenedor: cerrar prolijo evita cortar
  // un guardado a la mitad.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.on(senal, async () => {
      await app.close()
      await Promise.all([pool.end(), poolSalud.end()].map((p) => p.catch(() => {})))
      process.exit(0)
    })
  }
}
