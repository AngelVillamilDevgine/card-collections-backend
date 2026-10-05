/* Lo que frena las cuentas basura al registrarse. Lo pidió Angel el 2026-10-05, al ver
 * test@gmail.com y test2@gmail.com en el panel: «borrá esas cuentas de test y no permitas
 * que se creen más, deben ser todas de la misma IP».
 *
 * Que vinieran de la misma IP no se pudo comprobar: hasta ese día no se guardaba nada de la
 * conexión, ni en la base ni en el log (Traefik no registra cabeceras y Fastify ve la IP
 * del ingress). De ahí salen las dos reglas:
 *
 * 1. UN MAIL DE PRUEBA NO ES UNA CUENTA. El servidor no puede mandar mail, así que nadie
 *    comprueba que el mail sea de quien se registra: «test@gmail.com» entra igual que uno
 *    de verdad. Se frenan los nombres de prueba de siempre y los dominios de ejemplo.
 *
 * 2. A LO SUMO TRES CUENTAS POR CONEXIÓN EN 24 HORAS. El freno de `servidor.js` (diez
 *    intentos cada quince minutos) para una ráfaga, pero deja crear unas novecientas por
 *    día de a poco. Tres alcanza para una familia con la misma wifi y para los datos del
 *    celular, que salen por IPs compartidas (CGNAT) entre mucha gente: con quince altas
 *    por día repartidas en miles de IPs de cada compañía, que cuatro caigan en la misma es
 *    raro de verdad.
 *
 *    La conexión NO se guarda: se guarda un HMAC de ella, con una clave que sólo tiene el
 *    servidor (la URL de la base, que es un secret del swarm). Sirve para saber si dos
 *    altas vienen de la misma conexión y no para saber cuál es: un hash pelado de una IPv4
 *    se revierte probando las cuatro mil millones. Es la misma idea de `pulse`, que no
 *    guarda IPs. Si la clave cambia, los HMAC viejos dejan de coincidir y el tope arranca
 *    de cero, que es el lado inofensivo.
 *
 *    En IPv6 cuenta la red /64 y no la dirección: cada casa tiene una /64 entera y puede
 *    estrenar una dirección por pedido. */
import { createHmac } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

export const SIGNUPS_PER_CONNECTION = 3

/* Lo de antes de la @ —sin los puntos, que Gmail ignora, y sin lo que va después de un
   «+»—, contra las palabras de probar y nada más: «test», «test2», «prueba1», «asdf»…
   Una palabra que sólo EMPIEZA así («testarossa», «pruebaonline») pasa.

   Los números al final se aceptan SÓLO detrás de una palabra: «aa1985», «asd1990» o
   «A01234567» son iniciales con el año o una matrícula —la casilla de hotmail de toda la
   vida de este público— y una primera versión los frenaba. Sin números, «asd», «qwerty»
   o una tira de aes sí son de prueba. */
const TEST_WORD = /^(test|tests|testing|tester|prueba|pruebas|probando|demo|fake|falso|ejemplo|example)[\d_-]*$/
const TEST_ALONE = /^(asd|asdf|asdasd|qwe|qwerty|a{3,}|x{3,})$/
const TEST_DOMAIN = /^(example\.(com|org|net)|test\.com|prueba\.com|mailinator\.com)$/

export function looksLikeTestEmail(mail) {
  /* NFKC lleva las letras «anchas» (ｔｅｓｔ) a las de siempre, y \p{Cf} saca los
     caracteres invisibles: si no, «te[espacio invisible]st» pasaba y la base lo guardaba igual a «test». */
  const plain = String(mail).normalize('NFKC').replace(/\p{Cf}/gu, '')
  const [local = '', domain = ''] = plain.toLowerCase().split('@')
  const bare = local.split('+')[0].replace(/\./g, '')
  return TEST_WORD.test(bare) || TEST_ALONE.test(bare) || TEST_DOMAIN.test(domain)
}

/* LAS ALTAS DE UNA MISMA CONEXIÓN, DE A UNA. Contar y después insertar deja pasar a todas
   las que llegan juntas: entre el COUNT y el INSERT está el scrypt (~100 ms), y diez pedidos
   a la vez veían los diez «cero cuentas» —medido: diez altas desde una IP, cuarenta desde
   una /64—. En fila por conexión, cada una cuenta lo que dejó la anterior. Es de este
   proceso: corre una sola réplica, y los dos minutos en que convive con la versión vieja
   durante un deploy se aceptan. La cola se borra sola cuando se vacía. */
const queues = new Map()
export function oneAtATime(key, task) {
  const before = queues.get(key) ?? Promise.resolve()
  const run = before.then(task, task)
  const tail = run.then(() => {}, () => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}

/* La red de una IP: la IPv4 entera, o los primeros 64 bits de una IPv6 escritos siempre
   igual (con los ceros, sin el «::» abreviado). Una IPv4 escrita como IPv6
   (::ffff:1.2.3.4) es la IPv4. */
export function networkOf(ip) {
  const raw = String(ip ?? '').trim().replace(/%.*$/, '')
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]
  if (isIPv4(raw)) return raw
  if (!isIPv6(raw)) return raw
  const [head, tail = ''] = raw.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':') + '::/64'
}

export const connectionKey = (ip, secret) =>
  createHmac('sha256', String(secret)).update(networkOf(ip)).digest('hex')
