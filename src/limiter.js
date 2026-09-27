/* El freno a la fuerza bruta.
 *
 * Vivía adentro de `armarServidor`, en un closure, y por eso NO SE PODÍA PROBAR: lo único
 * que se le podía hacer era pegarle por HTTP, y las dos reglas que más importan —el tope de
 * baldes y a quién se desaloja— necesitan cinco mil baldes, o sea cinco mil scrypt. Nadie
 * corre ese test. Acá afuera son microsegundos y el reloj se puede inyectar.
 *
 * CUENTA FRACASOS, NO INTENTOS, y bajo dos llaves a la vez:
 *
 *     ip|usuario -> el que le pega a UNA cuenta
 *     ip         -> el que prueba la misma clave en muchas cuentas
 *
 * Un login bueno perdona sólo la primera. Esa separación no es capricho: antes se contaban
 * todos los intentos por IP y perdonar borraba el balde entero, así que al atacante le
 * alcanzaba con registrarse una cuenta propia y usarla de botón de reinicio —diez tiros a
 * la víctima, uno bueno a la suya, y a empezar—. No lo tapaba ninguna otra defensa.
 *
 * Y las dos cosas que el closure tenía mal, las dos por el mismo lado: el Map lo llena el
 * cliente. Ver `key` y `evict`.
 */

/* 15 minutos. Pasado eso el balde no frena más y se puede tirar. */
export const WINDOW = 15 * 60 * 1000

/* Cuántos baldes se guardan como mucho. La llave la arma en parte el cliente, así que sin
   tope se puede hacer crecer el Map hasta voltear el proceso, que tiene 256 MB. */
export const MAX_BUCKETS = 5000

/* EL TOPE DE ARRIBA CUENTA BALDES Y NO BYTES, así que además se corta la llave.
   La llave se arma con lo que manda el cliente: el usuario sale del cuerpo y la IP de una
   cabecera. Con un usuario de un megabyte —el límite de cuerpo de Fastify— cinco mil
   baldes son cinco gigas: alcanzaban unos trescientos pedidos para voltear la API.

   64 es el ancho de la columna `usuario`, o sea que ningún nombre de verdad se toca. Y si
   dos recortados cayeran en el mismo balde, el freno queda MÁS estricto, que es el lado
   seguro. La IPv6 más larga son 45 caracteres. */
export const MAX_KEY_PART = 64

export function createLimiter({
  window = WINDOW,
  maxBuckets = MAX_BUCKETS,
  maxKeyPart = MAX_KEY_PART,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map()

  const trim = (part) => (part == null ? '' : String(part).slice(0, maxKeyPart))
  const key = (...parts) => parts.map(trim).join('|')

  const fresh = (b, t) => t - b.desde <= window

  /* LEER NO CREA BALDE, y es la mitad del arreglo. `frenado` llamaba al creador: un pedido
     que ya salía frenado —429 antes del scrypt, o sea gratis para quien lo manda— igual
     estrenaba un balde por cada usuario inventado, así que el Map se llenaba sin pagar
     nada. Ahora llenarlo cuesta un fracaso de verdad cada vez, con su scrypt, y esos
     fracasos además se cuentan contra la propia IP del que los hace. */
  function blocked(k, max) {
    const b = buckets.get(k)
    return !!b && fresh(b, now()) && b.n >= max
  }

  function bucket(k) {
    const t = now()
    const previo = buckets.get(k)
    if (previo && fresh(previo, t)) return previo
    if (buckets.size >= maxBuckets) evict()
    const nuevo = { n: 0, desde: t }
    buckets.set(k, nuevo)
    return nuevo
  }

  /* SE TIRAN LOS QUE MENOS SABEN, NO LOS MÁS VIEJOS.
     Tirando por antigüedad —un Map itera por orden de inserción— el atacante decide qué es
     viejo: llenando el Map hacía caer el contador de su propia IP y volvía a empezar. Es
     el mismo botón de reinicio que las dos llaves vinieron a sacarle, entrando por la
     puerta de al lado. El código de antes ya sabía que un `clear()` se lo daría; el
     desalojo parcial se lo daba igual, sólo que de a poco.

     Un balde con un fracaso no informa casi nada; el que llegó al tope es justamente el que
     hay que guardar. Los vencidos valen menos que cualquiera, porque ya no frenan a nadie.
     Para desalojar uno que llegó a diez hacen falta cinco mil baldes de diez, o sea
     cincuenta mil fracasos de verdad. */
  function evict() {
    const t = now()
    const vale = (b) => (fresh(b, t) ? b.n : -1)
    const peores = [...buckets.entries()].sort((a, b) => vale(a[1]) - vale(b[1]) || a[1].desde - b[1].desde)
    for (const [k] of peores) {
      buckets.delete(k)
      if (buckets.size < maxBuckets * 0.9) break
    }
  }

  const fail = (k) => { bucket(k).n++ }
  const forgive = (k) => buckets.delete(k)

  /* Los vencidos, cada tanto. No hace falta que sea puntual: `blocked` ya mira la ventana,
     así que un balde vencido que siga en el Map no frena a nadie — sólo ocupa lugar. */
  function sweep() {
    const t = now()
    for (const [k, b] of buckets) if (!fresh(b, t)) buckets.delete(k)
  }

  return { key, blocked, fail, forgive, sweep, size: () => buckets.size, count: (k) => buckets.get(k)?.n ?? 0 }
}
