// Los números para decidir sobre la app. No hay gráficos ni métricas de vanidad: lo que
// importa es cuántos entran, cuántos la usan de verdad y cuántos vuelven.
//
// "Última vez" y "días" salen de la tabla `visita`, que anota un día por usuario la
// primera vez que pide algo en el día. Cuesta un INSERT por usuario por día, no uno
// por cada toque de carta.

const TOTAL_CARTAS = 1936 // la colección completa; el front la saca del catálogo

/* El MySQL del servidor corre en UTC y acá son las tres menos: sin esto, todo lo que
   pasa después de las nueve de la noche cuenta como del día siguiente. Argentina no
   mueve la hora desde 2009, así que el -03:00 fijo alcanza y no hace falta que la base
   tenga cargadas las tablas de husos (los desplazamientos numéricos andan siempre). */
const aca = (col) => `CONVERT_TZ(${col}, '+00:00', '-03:00')`

/* Number() a propósito: MySQL devuelve los SUM() como texto, porque son DECIMAL, y
   entonces 2 no es igual a '2' del otro lado. */
async function una(pool, sql, args = []) {
  const [filas] = await pool.query(sql, args)
  const valor = filas[0] ? Object.values(filas[0])[0] : 0
  return valor == null ? 0 : Number(valor)
}

/* Un día por usuario y nada más. El Map evita repetir el INSERT en cada pedido: se
   pierde al reiniciar y entonces se hace uno de más, que no le duele a nadie.

   Sin await a propósito: nadie espera por una estadística. Si falla, se olvida la
   marca para volver a intentar en el pedido siguiente. */
const anotados = new Map()

export const hoyAca = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)

export function anotarVisita(pool, usuarioId, esApp = false) {
  const hoy = hoyAca()
  // La marca lleva si vino de la app: si hoy ya entró por el navegador y después abre
  // la app, la fila tiene que pasar a contar como app igual.
  const marca = `${hoy}:${esApp ? 1 : 0}`
  if (anotados.get(usuarioId) === marca) return
  if (anotados.size > 5000) anotados.clear() // que no crezca para siempre
  anotados.set(usuarioId, marca)
  // Devuelve la promesa por si alguien quiere esperarla (los tests); el servidor no.
  return pool
    .query(
      `INSERT INTO visita (usuario_id, dia, app) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE app = GREATEST(app, VALUES(app))`,
      [usuarioId, hoy, esApp ? 1 : 0]
    )
    .catch(() => anotados.delete(usuarioId))
}

export async function resumen(pool) {
  const [usuarios, conCartas, cartas, repetidas, altas7, altasHoy, volvieron, activosHoy, activos7, conApp] =
    await Promise.all([
      una(pool, 'SELECT COUNT(*) FROM usuario'),
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM carta'),
      una(pool, 'SELECT COALESCE(SUM(cantidad - 1), 0) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM usuario WHERE creado > NOW() - INTERVAL 7 DAY'),
      una(pool, `SELECT COUNT(*) FROM usuario WHERE DATE(${aca('creado')}) = DATE(${aca('NOW()')})`),
      // Volver otro día es la señal de que la app sirve para algo. Se cuenta con
      // `visita`, no con `sesion`: la sesión dura 30 días, así que el que entra una
      // vez y la usa todos los días no crea ninguna sesión nueva.
      una(pool, `SELECT COUNT(*) FROM (
                   SELECT usuario_id FROM visita GROUP BY usuario_id
                    HAVING COUNT(*) > 1) t`),
      una(pool, 'SELECT COUNT(*) FROM visita WHERE dia = ?', [hoyAca()]),
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM visita WHERE dia > DATE_SUB(?, INTERVAL 7 DAY)', [hoyAca()]),
      // La instalaron en el teléfono. Es el paso que más hace volver a la gente.
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM visita WHERE app = 1'),
    ])

  const [porDia] = await pool.query(
    `SELECT DATE_FORMAT(${aca('creado')}, '%Y-%m-%d') dia, COUNT(*) cuantos FROM usuario
      WHERE creado > NOW() - INTERVAL 14 DAY
      GROUP BY dia ORDER BY dia`
  )

  const [tramos] = await pool.query(
    `SELECT CASE WHEN n = 0 THEN 'Ninguna'
                 WHEN n < 10 THEN '1 a 9'
                 WHEN n < 100 THEN '10 a 99'
                 WHEN n < 500 THEN '100 a 499'
                 ELSE '500 o más' END tramo,
            COUNT(*) cuantos, MIN(n) orden
       FROM (SELECT u.id, COUNT(c.clave) n
               FROM usuario u LEFT JOIN carta c ON c.usuario_id = u.id
              GROUP BY u.id) x
      GROUP BY tramo ORDER BY orden`
  )

  const [gente] = await pool.query(
    `SELECT u.usuario,
            DATE_FORMAT(${aca('u.creado')}, '%Y-%m-%d') alta,
            COUNT(c.clave) cartas,
            COALESCE(SUM(c.cantidad - 1), 0) repetidas,
            (SELECT DATE_FORMAT(MAX(v.dia), '%Y-%m-%d') FROM visita v WHERE v.usuario_id = u.id) ultima,
            (SELECT COUNT(*) FROM visita v WHERE v.usuario_id = u.id) dias,
            (SELECT MAX(v.app) FROM visita v WHERE v.usuario_id = u.id) app
       FROM usuario u LEFT JOIN carta c ON c.usuario_id = u.id
      GROUP BY u.id
      ORDER BY cartas DESC, u.creado DESC`
  )

  return {
    total: TOTAL_CARTAS,
    usuarios: { total: usuarios, conCartas, altas7, altasHoy, volvieron, activosHoy, activos7, conApp },
    cartas: { total: cartas, repetidas },
    porDia: porDia.map((f) => ({ dia: f.dia, cuantos: Number(f.cuantos) })),
    tramos: tramos.map((f) => ({ tramo: f.tramo, cuantos: Number(f.cuantos) })),
    gente: gente.map((f) => ({
      usuario: f.usuario,
      alta: f.alta,
      cartas: Number(f.cartas),
      repetidas: Number(f.repetidas),
      ultima: f.ultima ?? null,
      dias: Number(f.dias),
      app: Number(f.app) === 1,
    })),
  }
}
