// Los números para decidir sobre la app. No hay gráficos ni métricas de vanidad: lo que
// importa es cuántos entran, cuántos la usan de verdad y cuántos vuelven.
//
// "Última entrada" sale de cuándo se creó la sesión más nueva. No hay una columna de
// última actividad en carta, y agregarla costaría una escritura por cada toque.

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

export async function resumen(pool) {
  const [usuarios, conCartas, cartas, repetidas, altas7, altasHoy, volvieron, sesiones] =
    await Promise.all([
      una(pool, 'SELECT COUNT(*) FROM usuario'),
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM carta'),
      una(pool, 'SELECT COALESCE(SUM(cantidad - 1), 0) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM usuario WHERE creado > NOW() - INTERVAL 7 DAY'),
      una(pool, `SELECT COUNT(*) FROM usuario WHERE DATE(${aca('creado')}) = DATE(${aca('NOW()')})`),
      // Volver otro día es la señal de que la app sirve para algo.
      una(pool, `SELECT COUNT(*) FROM (
                   SELECT usuario_id FROM sesion GROUP BY usuario_id
                    HAVING COUNT(DISTINCT DATE(${aca('creado')})) > 1) t`),
      una(pool, 'SELECT COUNT(*) FROM sesion WHERE vence > NOW()'),
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
            (SELECT DATE_FORMAT(${aca('MAX(s.creado)')}, '%Y-%m-%d') FROM sesion s WHERE s.usuario_id = u.id) ultima,
            (SELECT COUNT(DISTINCT DATE(${aca('s.creado')})) FROM sesion s WHERE s.usuario_id = u.id) dias
       FROM usuario u LEFT JOIN carta c ON c.usuario_id = u.id
      GROUP BY u.id
      ORDER BY cartas DESC, u.creado DESC`
  )

  return {
    total: TOTAL_CARTAS,
    usuarios: { total: usuarios, conCartas, altas7, altasHoy, volvieron, sesiones },
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
    })),
  }
}
