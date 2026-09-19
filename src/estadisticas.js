// Los números para decidir sobre la app. No hay gráficos ni métricas de vanidad: lo que
// importa es cuántos entran, cuántos la usan de verdad y cuántos vuelven.
//
// "Última entrada" sale de cuándo se creó la sesión más nueva. No hay una columna de
// última actividad en carta, y agregarla costaría una escritura por cada toque.

const TOTAL_CARTAS = 1936 // la colección completa; el front la saca del catálogo

async function una(pool, sql, args = []) {
  const [filas] = await pool.query(sql, args)
  return filas[0] ? Object.values(filas[0])[0] : 0
}

export async function resumen(pool) {
  const [usuarios, conCartas, cartas, repetidas, altas7, altasHoy, volvieron, sesiones] =
    await Promise.all([
      una(pool, 'SELECT COUNT(*) FROM usuario'),
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM carta'),
      una(pool, 'SELECT COALESCE(SUM(cantidad - 1), 0) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM usuario WHERE creado > NOW() - INTERVAL 7 DAY'),
      una(pool, 'SELECT COUNT(*) FROM usuario WHERE DATE(creado) = CURDATE()'),
      // Volver otro día es la señal de que la app sirve para algo.
      una(pool, `SELECT COUNT(*) FROM (
                   SELECT usuario_id FROM sesion GROUP BY usuario_id
                    HAVING COUNT(DISTINCT DATE(creado)) > 1) t`),
      una(pool, 'SELECT COUNT(*) FROM sesion WHERE vence > NOW()'),
    ])

  const [porDia] = await pool.query(
    `SELECT DATE(creado) dia, COUNT(*) cuantos FROM usuario
      WHERE creado > NOW() - INTERVAL 14 DAY
      GROUP BY DATE(creado) ORDER BY dia`
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
            DATE(u.creado) alta,
            COUNT(c.clave) cartas,
            COALESCE(SUM(c.cantidad - 1), 0) repetidas,
            (SELECT DATE(MAX(s.creado)) FROM sesion s WHERE s.usuario_id = u.id) ultima,
            (SELECT COUNT(DISTINCT DATE(s.creado)) FROM sesion s WHERE s.usuario_id = u.id) dias
       FROM usuario u LEFT JOIN carta c ON c.usuario_id = u.id
      GROUP BY u.id
      ORDER BY cartas DESC, u.creado DESC`
  )

  return {
    total: TOTAL_CARTAS,
    usuarios: { total: usuarios, conCartas, altas7, altasHoy, volvieron, sesiones },
    cartas: { total: cartas, repetidas },
    porDia: porDia.map((f) => ({ dia: String(f.dia).slice(0, 10), cuantos: Number(f.cuantos) })),
    tramos: tramos.map((f) => ({ tramo: f.tramo, cuantos: Number(f.cuantos) })),
    gente: gente.map((f) => ({
      usuario: f.usuario,
      alta: String(f.alta).slice(0, 10),
      cartas: Number(f.cartas),
      repetidas: Number(f.repetidas),
      ultima: f.ultima ? String(f.ultima).slice(0, 10) : null,
      dias: Number(f.dias),
    })),
  }
}
