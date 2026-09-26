// Lectura y escritura de cartas, siempre acotadas a un usuario.
//
// Hacia afuera se sigue hablando la forma que ya entiende el front —
// { estados: {clave: estado}, cantidades: {clave: n} } — aunque adentro sean filas.
// Así el front no se enteró del cambio de base.
const ESTADOS = new Set(['bien', 'perfecta', 'reemplazar'])

export async function leer(pool, usuarioId) {
  const [filas] = await pool.query(
    'SELECT clave, cantidad, estado FROM carta WHERE usuario_id = ?', [usuarioId]
  )
  const estados = {}
  const cantidades = {}
  for (const f of filas) {
    cantidades[f.clave] = f.cantidad
    if (f.estado) estados[f.clave] = f.estado
  }
  return { estados, cantidades }
}

/* Una carta suelta: es el camino que usa cada toque, y manda unos pocos bytes. */
export async function guardarCarta(pool, usuarioId, clave, cantidad, estado) {
  if (!(cantidad > 0)) {
    // Cantidad 0 es no tener la carta, y no tenerla es no tener fila.
    await pool.query('DELETE FROM carta WHERE usuario_id = ? AND clave = ?', [usuarioId, clave])
    return
  }
  // VALUES() y no la forma con alias: la de alias pide MySQL 8.0.19 y no sé qué
  // versión corre en el servidor. Ésta anda en 5.7 y en 8.
  await pool.query(
    `INSERT INTO carta (usuario_id, clave, cantidad, estado) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cantidad = VALUES(cantidad), estado = VALUES(estado)`,
    [usuarioId, clave, cantidad, ESTADOS.has(estado) ? estado : null]
  )
}

/* La colección entera de una. La usa "Restaurar una copia" y la importación. */
export async function reemplazar(pool, usuarioId, cuerpo) {
  /* A mano y no con valores por defecto en la firma: `{ estados = {} }` sólo salta con
     `undefined`, no con `null`. Un `{"estados": null, "cantidades": {...}}` —que es lo
     que deja una copia vieja o un archivo armado a mano— llegaba hasta `estados[clave]`
     y reventaba con un 500 sin explicación. */
  const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const estados = objeto(cuerpo?.estados)
  const cantidades = objeto(cuerpo?.cantidades)

  const conexion = await pool.getConnection()
  try {
    // En transacción: o entra toda, o no entra nada y queda la de antes.
    await conexion.beginTransaction()
    await conexion.query('DELETE FROM carta WHERE usuario_id = ?', [usuarioId])

    const filas = Object.entries(cantidades)
      .map(([clave, n]) => [usuarioId, clave, Number(n), estados[clave]])
      .filter(([, , n]) => n > 0)
      .map(([u, c, n, e]) => [u, c, n, ESTADOS.has(e) ? e : null])

    // De a mil por vez: mandar 1936 filas en un solo INSERT puede pasarse de
    // max_allowed_packet, y el error que tira no dice qué pasó.
    for (let i = 0; i < filas.length; i += 1000) {
      const tanda = filas.slice(i, i + 1000)
      await conexion.query(
        'INSERT INTO carta (usuario_id, clave, cantidad, estado) VALUES ?', [tanda]
      )
    }
    await conexion.commit()
    return filas.length
  } catch (e) {
    await conexion.rollback()
    throw e
  } finally {
    conexion.release()
  }
}

/* Lo que puede llegar por la red no se guarda sin mirarlo. */
export function revisarCarta(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return 'Cuerpo inválido.'
  const { cantidad, estado } = cuerpo
  if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > 9999)
    return 'La cantidad tiene que ser un entero entre 0 y 9999.'
  if (estado != null && !ESTADOS.has(estado)) return 'Estado desconocido.'
  return null
}

/* El tope tiene que cerrar con la columna, que es VARCHAR(40). Con {1,40} antes del
   ':' la clave entera podía llegar a 46 caracteres: pasaba la validación, el INSERT
   tiraba ER_DATA_TOO_LONG y salía un 500 con traza en vez de un 400 que explica. Y si
   el MySQL corriera sin modo estricto sería peor: truncaría, y dos claves distintas
   colisionarían en la primaria, que es lo que separa la colección de uno de la del otro.
   34 + ':' + 5 dígitos = 40 justos, y el id de expansión más largo del catálogo tiene
   once caracteres, así que sobra. */
export const claveValida = (clave) => /^[a-z0-9-]{1,34}:\d{1,5}$/.test(clave)

/* Tope de filas de un reemplazo. Con el `bodyLimit` de 2 MB entran más de 139.000 claves
   de formato válido en un solo pedido, y sin techo una cuenta gratuita —el registro es
   abierto— podía dejar millones de filas en el MySQL que comparten los clientes.

   EL NÚMERO NO PERSIGUE AL CATÁLOGO, Y ESO ES A PROPÓSITO. Estaba en 2200 «porque la
   colección son 1936», y eso lo convierte en un segundo lugar donde vive el tamaño del
   catálogo — el mismo error que se sacó de `estadisticas.js` con el `TOTAL_CARTAS = 1936`.
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
export const TOPE_CARTAS = 10000

/* Las tres guardas del único camino de toda la app que borra en masa, juntas y en un solo
   lugar.

   Estaban adentro de la ruta `PUT /api/coleccion`, y por eso `bin/importar.js` —que llama
   a `reemplazar()` directo, sin pasar por HTTP— no tenía NINGUNA de las tres. Justamente
   la herramienta que se usa para recuperar un respaldo era la que menos miraba lo que le
   daban: un `null`, un `[]` o el json de cualquier otra cosa borraba la colección entera
   y contestaba «Listo: 0 cartas». Separadas, se arregla una y la otra queda.

   Devuelve el texto del problema, o `null` si está bien. El texto es el mismo que
   contesta la API, así que el que restaura desde el navegador y el que corre el script
   leen lo mismo. */
export function revisarReemplazo(cuerpo) {
  const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const cantidades = objeto(cuerpo?.cantidades)
  const estados = objeto(cuerpo?.estados)
  const claves = Object.keys(cantidades)

  if (claves.length > TOPE_CARTAS)
    return `Son demasiadas cartas: ${claves.length}.`

  /* Clave por clave ANTES de contar, y el orden importa: con la cuenta primero, un archivo
     con `{"exp-1:1": -3}` contestaba «esta copia no tiene ninguna carta» — verdad, pero
     manda a mirar donde no está el problema. El -3 no es un archivo vacío: es un archivo
     roto, y hay que decirlo. */
  for (const clave of claves) {
    if (!claveValida(clave)) return `Clave inválida: ${clave}`
    /* Las cantidades se validan igual que en el PUT de una carta sola. Antes este camino
       —el que reemplaza TODO— sólo hacía Number(n) y filtraba n > 0: un -3 o un "hola"
       desaparecían sin decir nada, un 1.7 se redondeaba y un 999999999 se pasaba del
       SMALLINT y salía por un 500 que no explicaba nada. El camino peligroso validaba
       menos que el seguro. */
    const mala = revisarCarta({ cantidad: cantidades[clave], estado: estados[clave] ?? null })
    if (mala) return `${clave}: ${mala}`
  }

  /* Un reemplazo sin NINGUNA carta no es un caso de uso: es el síntoma de que el archivo
     que eligieron no era una copia. Antes contestaba 200 y borraba todo. Si alguna vez
     hace falta un «empezar de cero», que vaya por su propio camino y a propósito.

     SE CUENTAN LAS CARTAS, NO LAS CLAVES, y esa distinción es todo el arreglo. Contando
     claves, un archivo como `{"cantidades":{"exp-1:1":0,"exp-1:2":0}}` pasaba las tres
     capas: las claves son válidas y `revisarCarta` acepta la cantidad 0 a propósito
     —es la que borra una carta sola—. Después `reemplazar()` filtra por `n > 0` y no
     inserta nada, así que borraba la colección entera y contestaba 200 con `cartas: 0`.
     O sea: la única capa que protege aunque el front tenga un bug no protegía de esto. */
  if (!claves.some((c) => Number(cantidades[c]) > 0))
    return 'Esa copia no tiene ninguna carta. No se cambió nada de tu colección.'

  return null
}

/* Devuelve `null` si el archivo NO es una copia de la colección, en vez de inventar una
   vacía. Es el mismo criterio que `normalizar` en frontend/src/almacenamiento.js: están
   duplicados porque son dos repos y no hay forma de compartir el módulo. Si se toca uno,
   tocar el otro — y hay tests de los dos lados.

   Sigue leyendo las tres formas históricas, porque un respaldo puede ser viejo. */
export function normalizarCopia(datos) {
  const esMapa = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!esMapa(datos)) return null

  // La forma de hoy: { estados, cantidades }.
  if (esMapa(datos.cantidades))
    return { estados: esMapa(datos.estados) ? datos.estados : {}, cantidades: datos.cantidades }

  // Una anterior: { estados, repetidas }, donde "repetidas" eran las que SOBRABAN.
  if (esMapa(datos.estados)) {
    const cantidades = {}
    for (const clave of Object.keys(datos.estados))
      cantidades[clave] = 1 + (datos.repetidas?.[clave] ?? 0)
    return { estados: datos.estados, cantidades }
  }

  /* La más vieja: un mapa de estados suelto. Se reconoce porque TODAS sus claves tienen
     forma de carta; si alguna no, es otro archivo cualquiera y no se toca nada. Sin esta
     condición, un package.json entraba como colección válida. */
  const claves = Object.keys(datos)
  if (claves.length && claves.every(claveValida)) {
    const cantidades = {}
    for (const clave of claves) cantidades[clave] = 1
    return { estados: datos, cantidades }
  }

  return null
}
