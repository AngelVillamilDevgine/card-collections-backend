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
