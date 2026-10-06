// Lectura y escritura de cartas, siempre acotadas a un usuario.
//
// Hacia afuera se sigue hablando la forma que ya entiende el front —
// { estados: {clave: estado}, cantidades: {clave: n} } — aunque adentro sean filas.
// Así el front no se enteró del cambio de base.
const CONDITIONS = new Set(['bien', 'perfecta', 'reemplazar'])

export async function readCollection(pool, userId) {
  const [rows] = await pool.query(
    'SELECT clave, cantidad, estado FROM carta WHERE usuario_id = ?', [userId]
  )
  const conditions = {}
  const quantities = {}
  for (const f of rows) {
    quantities[f.clave] = f.cantidad
    if (f.estado) conditions[f.clave] = f.estado
  }
  return { estados: conditions, cantidades: quantities }
}

/* Una carta suelta: es el camino que usa cada toque, y manda unos pocos bytes. */
export async function saveCard(pool, userId, cardKey, quantity, condition) {
  if (!(quantity > 0)) {
    // Cantidad 0 es no tener la carta, y no tenerla es no tener fila.
    await pool.query('DELETE FROM carta WHERE usuario_id = ? AND clave = ?', [userId, cardKey])
    return
  }
  // VALUES() y no la forma con alias: la de alias pide MySQL 8.0.19 y no sé qué
  // versión corre en el servidor. Ésta anda en 5.7 y en 8.
  await pool.query(
    `INSERT INTO carta (usuario_id, clave, cantidad, estado) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cantidad = VALUES(cantidad), estado = VALUES(estado)`,
    [userId, cardKey, quantity, CONDITIONS.has(condition) ? condition : null]
  )
}

/* La colección entera de una. La usa "Restaurar una copia" y la importación. */
export async function replaceCollection(pool, userId, body) {
  /* A mano y no con valores por defecto en la firma: `{ estados = {} }` sólo salta con
     `undefined`, no con `null`. Un `{"estados": null, "cantidades": {...}}` —que es lo
     que deja una copia vieja o un archivo armado a mano— llegaba hasta `conditions[cardKey]`
     y reventaba con un 500 sin explicación. */
  const asPlainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const conditions = asPlainObject(body?.estados)
  const quantities = asPlainObject(body?.cantidades)

  const connection = await pool.getConnection()
  try {
    // En transacción: o entra toda, o no entra nada y queda la de antes.
    await connection.beginTransaction()
    await connection.query('DELETE FROM carta WHERE usuario_id = ?', [userId])

    const rows = Object.entries(quantities)
      .map(([cardKey, n]) => [userId, cardKey, Number(n), conditions[cardKey]])
      .filter(([, , n]) => n > 0)
      .map(([u, c, n, e]) => [u, c, n, CONDITIONS.has(e) ? e : null])

    // De a mil por vez: mandar 1936 filas en un solo INSERT puede pasarse de
    // max_allowed_packet, y el error que tira no dice qué pasó.
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000)
      await connection.query(
        'INSERT INTO carta (usuario_id, clave, cantidad, estado) VALUES ?', [batch]
      )
    }
    await connection.commit()
    return rows.length
  } catch (e) {
    await connection.rollback()
    throw e
  } finally {
    connection.release()
  }
}

/* Lo que puede llegar por la red no se guarda sin mirarlo. */
export function validateCard(body) {
  if (!body || typeof body !== 'object') return 'Cuerpo inválido.'
  const { cantidad: quantity, estado: condition } = body
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999)
    return 'La cantidad tiene que ser un entero entre 0 y 9999.'
  if (condition != null && !CONDITIONS.has(condition)) return 'Estado desconocido.'
  return null
}

/* El tope tiene que cerrar con la columna, que es VARCHAR(40). Con {1,40} antes del
   ':' la clave entera podía llegar a 46 caracteres: pasaba la validación, el INSERT
   tiraba ER_DATA_TOO_LONG y salía un 500 con traza en vez de un 400 que explica. Y si
   el MySQL corriera sin modo estricto sería peor: truncaría, y dos claves distintas
   colisionarían en la primaria, que es lo que separa la colección de uno de la del otro.
   34 + ':' + 5 dígitos = 40 justos, y el id de expansión más largo del catálogo tiene
   once caracteres, así que sobra. */
export const isValidCardKey = (cardKey) => /^[a-z0-9-]{1,34}:\d{1,5}$/.test(cardKey)

/* Tope de filas de un reemplazo. Con el `bodyLimit` de 2 MB entran más de 139.000 claves
   de formato válido en un solo pedido, y sin techo una cuenta gratuita —el registro es
   abierto— podía dejar millones de filas en el MySQL que comparten los clientes.

   EL NÚMERO NO PERSIGUE AL CATÁLOGO, Y ESO ES A PROPÓSITO. Estaba en 2200 «porque la
   colección son 1936», y eso lo convierte en un segundo lugar donde vive el tamaño del
   catálogo — el mismo error que se sacó de `stats.js` con el `TOTAL_CARTAS = 1936`.
   Peor: el catálogo se edita en caliente, sin deploy y sin ningún test que mire esto, así
   que el día que crezca el techo lo alcanza en silencio y lo primero que se rompe es
   «Restaurar una copia», el único camino de recuperación, justo cuando hace falta.

   Así que está elegido contra lo que de verdad cuesta: la transacción. Medido contra
   MySQL 9 con el esquema real (contenedor local, más rápido que el VPS — escalá x3 para
   estimar producción):

       1936 filas   128 ms        10.000 filas   330 ms
       5000 filas   161 ms        20.000 filas   660 ms

   Y lo que importaba más: mientras corre un reemplazo de 10.000 filas, **otra conexión
   escribiendo en OTRA cuenta espera 35 ms**. InnoDB traba por fila y las filas van por
   `usuario_id`, así que esto no le pisa la base a nadie. */
/* CUÁNTAS DE LAS QUE YA TENÉS NO VIENEN EN LA COPIA.
 *
 * Se cuenta clave por clave y NO restando totales, y la diferencia no es cosmética: un
 * respaldo viejo de 600 cartas que sólo comparte 480 con tus 546 da `546 - 600 = -54`,
 * así que el aviso no se dibuja y el mensaje se lee como que ganás — cuando en realidad
 * perdés 66. Es el caso típico de restaurar desde otro aparato.
 *
 * Y el peor caso es el que la resta calla del todo: dos colecciones del mismo tamaño y
 * completamente distintas dan 0, y el único camino que borra en masa se corre sin avisar.
 *
 * La app ya lo hacía así y lo tenía escrito; `bin/import-collection.js` se quedó con la fórmula
 * vieja hasta el 2026-09-27, que es justo la herramienta que se usa para RECUPERAR un
 * respaldo. Vive acá para que no haya dos versiones de la misma cuenta. */
export function countLostCards(currentQuantities, backupQuantities) {
  const ownedKeysOf = (c) => Object.keys(c ?? {}).filter((k) => Number(c[k]) > 0)
  const backupKeys = new Set(ownedKeysOf(backupQuantities))
  return ownedKeysOf(currentQuantities).filter((k) => !backupKeys.has(k)).length
}

export const MAX_REPLACE_KEYS = 10000

/* Las tres guardas del único camino de toda la app que borra en masa, juntas y en un solo
   lugar.

   Estaban adentro de la ruta `PUT /api/coleccion`, y por eso `bin/import-collection.js` —que llama
   a `replaceCollection()` directo, sin pasar por HTTP— no tenía NINGUNA de las tres. Justamente
   la herramienta que se usa para recuperar un respaldo era la que menos miraba lo que le
   daban: un `null`, un `[]` o el json de cualquier otra cosa borraba la colección entera
   y contestaba «Listo: 0 cartas». Separadas, se arregla una y la otra queda.

   Devuelve el texto del problema, o `null` si está bien. El texto es el mismo que
   contesta la API, así que el que restaura desde el navegador y el que corre el script
   leen lo mismo. */
export function validateReplacement(body) {
  const asPlainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const quantities = asPlainObject(body?.cantidades)
  const conditions = asPlainObject(body?.estados)
  const cardKeys = Object.keys(quantities)

  if (cardKeys.length > MAX_REPLACE_KEYS)
    return `Son demasiadas cartas: ${cardKeys.length}.`

  /* Clave por clave ANTES de contar, y el orden importa: con la cuenta primero, un archivo
     con `{"exp-1:1": -3}` contestaba «esta copia no tiene ninguna carta» — verdad, pero
     manda a mirar donde no está el problema. El -3 no es un archivo vacío: es un archivo
     roto, y hay que decirlo. */
  for (const cardKey of cardKeys) {
    if (!isValidCardKey(cardKey)) return `Clave inválida: ${cardKey}`
    /* Las cantidades se validan igual que en el PUT de una carta sola. Antes este camino
       —el que reemplaza TODO— sólo hacía Number(n) y filtraba n > 0: un -3 o un "hola"
       desaparecían sin decir nada, un 1.7 se redondeaba y un 999999999 se pasaba del
       SMALLINT y salía por un 500 que no explicaba nada. El camino peligroso validaba
       menos que el seguro. */
    const problem = validateCard({ cantidad: quantities[cardKey], estado: conditions[cardKey] ?? null })
    if (problem) return `${cardKey}: ${problem}`
  }

  /* Un reemplazo sin NINGUNA carta no es un caso de uso: es el síntoma de que el archivo
     que eligieron no era una copia. Antes contestaba 200 y borraba todo. Si alguna vez
     hace falta un «empezar de cero», que vaya por su propio camino y a propósito.

     SE CUENTAN LAS CARTAS, NO LAS CLAVES, y esa distinción es todo el arreglo. Contando
     claves, un archivo como `{"cantidades":{"exp-1:1":0,"exp-1:2":0}}` pasaba las tres
     capas: las claves son válidas y `validateCard` acepta la cantidad 0 a propósito
     —es la que borra una carta sola—. Después `replaceCollection()` filtra por `n > 0` y no
     inserta nada, así que borraba la colección entera y contestaba 200 con `cartas: 0`.
     O sea: la única capa que protege aunque el front tenga un bug no protegía de esto. */
  if (!cardKeys.some((c) => Number(quantities[c]) > 0))
    return 'Esa copia no tiene ninguna carta. No se cambió nada de tu colección.'

  return null
}

/* Devuelve `null` si el archivo NO es una copia de la colección, en vez de inventar una
   vacía. Es el mismo criterio que `normalizeBackup` en frontend/src/api.js: están
   duplicados porque son dos repos y no hay forma de compartir el módulo. Si se toca uno,
   tocar el otro — y hay tests de los dos lados.

   Sigue leyendo las tres formas históricas, porque un respaldo puede ser viejo. */
export function normalizeBackup(data) {
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isPlainObject(data)) return null

  // La forma de hoy: { estados, cantidades }.
  if (isPlainObject(data.cantidades))
    return { estados: isPlainObject(data.estados) ? data.estados : {}, cantidades: data.cantidades }

  // Una anterior: { estados, repetidas }, donde "repetidas" eran las que SOBRABAN.
  if (isPlainObject(data.estados)) {
    const quantities = {}
    for (const cardKey of Object.keys(data.estados))
      quantities[cardKey] = 1 + (data.repetidas?.[cardKey] ?? 0)
    return { estados: data.estados, cantidades: quantities }
  }

  /* La más vieja: un mapa de estados suelto. Se reconoce porque TODAS sus claves tienen
     forma de carta; si alguna no, es otro archivo cualquiera y no se toca nada. Sin esta
     condición, un package.json entraba como colección válida. */
  const cardKeys = Object.keys(data)
  if (cardKeys.length && cardKeys.every(isValidCardKey)) {
    const quantities = {}
    for (const cardKey of cardKeys) quantities[cardKey] = 1
    return { estados: data, cantidades: quantities }
  }

  return null
}
