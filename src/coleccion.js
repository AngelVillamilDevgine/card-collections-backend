// Lectura y escritura de cartas, siempre acotadas a un usuario.
//
// Hacia afuera se sigue hablando la forma que ya entiende el front —
// { estados: {clave: estado}, cantidades: {clave: n} } — aunque adentro sean filas.
// Así el front no se enteró del cambio de base.
const ESTADOS = new Set(['bien', 'perfecta', 'reemplazar'])

export function leer(base, usuarioId) {
  const filas = base.prepare(
    'SELECT clave, cantidad, estado FROM carta WHERE usuario_id = ?'
  ).all(usuarioId)

  const estados = {}
  const cantidades = {}
  for (const f of filas) {
    cantidades[f.clave] = f.cantidad
    if (f.estado) estados[f.clave] = f.estado
  }
  return { estados, cantidades }
}

/* Una carta suelta: es el camino que usa cada toque, y manda unos pocos bytes. */
export function guardarCarta(base, usuarioId, clave, cantidad, estado) {
  if (!(cantidad > 0)) {
    // Cantidad 0 es no tener la carta, y no tenerla es no tener fila.
    base.prepare('DELETE FROM carta WHERE usuario_id = ? AND clave = ?').run(usuarioId, clave)
    return
  }
  base.prepare(
    `INSERT INTO carta (usuario_id, clave, cantidad, estado) VALUES (?, ?, ?, ?)
     ON CONFLICT(usuario_id, clave) DO UPDATE SET cantidad = excluded.cantidad,
                                                  estado   = excluded.estado`
  ).run(usuarioId, clave, cantidad, ESTADOS.has(estado) ? estado : null)
}

/* La colección entera de una. La usa "Restaurar una copia" y la importación. */
export function reemplazar(base, usuarioId, { estados = {}, cantidades = {} }) {
  const escribir = base.transaction(() => {
    base.prepare('DELETE FROM carta WHERE usuario_id = ?').run(usuarioId)
    for (const [clave, cantidad] of Object.entries(cantidades)) {
      guardarCarta(base, usuarioId, clave, Number(cantidad), estados[clave])
    }
  })
  escribir() // en transacción: o entra toda, o no entra nada y queda la de antes
  return base.prepare('SELECT count(*) n FROM carta WHERE usuario_id = ?').get(usuarioId).n
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

export const claveValida = (clave) => /^[a-z0-9-]{1,40}:\d{1,5}$/.test(clave)
