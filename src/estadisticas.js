// Los números para decidir sobre la app. No hay gráficos ni métricas de vanidad: lo que
// importa es cuántos entran, cuántos la usan de verdad y cuántos vuelven.
//
// "Última vez" y "días" salen de la tabla `visita`, que anota un día por usuario la
// primera vez que pide algo en el día. Cuesta un INSERT por usuario por día, no uno
// por cada toque de carta.

/* El MySQL del servidor corre en UTC y acá son las tres menos: sin esto, todo lo que
   pasa después de las nueve de la noche cuenta como del día siguiente. Argentina no
   mueve la hora desde 2009, así que el -03:00 fijo alcanza y no hace falta que la base
   tenga cargadas las tablas de husos (los desplazamientos numéricos andan siempre). */
const aca = (col) => `CONVERT_TZ(${col}, '+00:00', '-03:00')`

/* Cuánta gente entra en la tabla de «uno por uno». No es por el motor —se midió, y lo
   que cuesta es recorrer `carta`, que hay que recorrer igual— sino por lo que viaja:
   con 1000 cuentas la respuesta pasaba de 112 KB, y el panel lo abre alguien desde el
   teléfono. Con 200 son 22 KB. Arriba de eso, la tabla deja de ser una lista que se mira
   y pasa a ser una que se busca, y para eso haría falta otra cosa. */
const TOPE_GENTE = 200

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

/* El Map es de módulo y sobrevive al `DELETE FROM usuario` de los tests. Hoy no rompe
   porque el AUTO_INCREMENT no se reinicia y cada usuario nuevo estrena id, pero el día
   que alguien cambie ese DELETE por un TRUNCATE —que sí lo reinicia— el usuario 1 del
   test siguiente va a encontrar su propia marca del test anterior, la visita no se va a
   anotar nunca y el test se va a colgar esperándola, con un fallo que no dice nada.
   Con esto el que prepara la base puede vaciarlo también, y deja de ser una trampa. */
export const olvidarVisitas = () => anotados.clear()

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

/* Lo que escriben el respaldo y el despliegue, que corren fuera de la app. Se devuelve
   crudo con su fecha: quién decide si "hace tres días" es un problema es el panel, no
   esto. */
async function salud(pool) {
  const [filas] = await pool.query(
    `SELECT clave, valor,
            DATE_FORMAT(${aca('actualizado')}, '%Y-%m-%d %H:%i') actualizado,
            TIMESTAMPDIFF(MINUTE, actualizado, UTC_TIMESTAMP()) hace
       FROM salud`
  )
  const salida = {}
  for (const f of filas) {
    let valor = f.valor
    try { valor = JSON.parse(f.valor) } catch { /* si no es json, va el texto */ }
    // `hace` en minutos: que el panel no tenga que hacer cuentas con husos.
    salida[f.clave] = { valor, actualizado: f.actualizado, hace: Number(f.hace) }
  }
  return salida
}

export async function resumen(pool) {
  const [usuarios, conCartas, cartas, repetidas, altas7, altasHoy, volvieron, activosHoy, activos7, conApp] =
    await Promise.all([
      una(pool, 'SELECT COUNT(*) FROM usuario'),
      una(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM carta'),
      una(pool, 'SELECT COUNT(*) FROM carta'),
      una(pool, 'SELECT COALESCE(SUM(cantidad - 1), 0) FROM carta'),
      /* Por día LOCAL y no por ventana rodante de UTC. `creado > NOW() - INTERVAL 7 DAY`
         cuenta las últimas 168 horas contadas desde este instante, pero todo lo demás
         del panel agrupa por día de Argentina: los dos números no eran comparables, y
         el más viejo salía siempre recortado por las horas que ya habían pasado hoy. */
      una(pool, `SELECT COUNT(*) FROM usuario
                  WHERE DATE(${aca('creado')}) > DATE_SUB(?, INTERVAL 7 DAY)`, [hoyAca()]),
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
      WHERE DATE(${aca('creado')}) > DATE_SUB(?, INTERVAL 14 DAY)
      GROUP BY dia ORDER BY dia`,
    [hoyAca()]
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

  /* Las visitas se agregan UNA vez y se pegan, en vez de tres subconsultas correlacionadas
     por usuario. Medido con 1000 cuentas y 200.000 cartas: 229.002 filas leídas contra
     213.007, y 53 ms contra 43.

     Vale aclararlo porque la auditoría decía «2M de filas escaneadas» y eso NO es lo que
     pasa: las subconsultas caían sobre la primaria de `visita`, que empieza por
     usuario_id, así que costaban poco. Lo que domina es recorrer `carta` entera para
     contar por usuario, y eso hay que hacerlo igual — se probó con un índice angosto
     (usuario_id, cantidad) y lee exactamente las mismas filas.

     O sea que lo que de verdad crecía sin techo no era el motor: era la respuesta. */
  const [gente] = await pool.query(
    `SELECT u.usuario,
            DATE_FORMAT(${aca('u.creado')}, '%Y-%m-%d') alta,
            COALESCE(k.cartas, 0) cartas,
            COALESCE(k.repetidas, 0) repetidas,
            DATE_FORMAT(v.ultima, '%Y-%m-%d') ultima,
            COALESCE(v.dias, 0) dias,
            COALESCE(v.app, 0) app
       FROM usuario u
       LEFT JOIN (SELECT usuario_id, COUNT(*) cartas, COALESCE(SUM(cantidad - 1), 0) repetidas
                    FROM carta GROUP BY usuario_id) k ON k.usuario_id = u.id
       LEFT JOIN (SELECT usuario_id, MAX(dia) ultima, COUNT(*) dias, MAX(app) app
                    FROM visita GROUP BY usuario_id) v ON v.usuario_id = u.id
      ORDER BY cartas DESC, u.creado DESC
      LIMIT ?`,
    [TOPE_GENTE]
  )

  return {
    salud: await salud(pool),
    /* Acá había un `total: 1936` escrito a mano, que es el tamaño del catálogo. El
       catálogo vive en el front y se edita sin recompilar nada, así que el día que
       cambiara, el panel iba a seguir calculando los porcentajes de la columna «Álbum»
       contra un número viejo — mintiendo en silencio, porque ningún test puede ver los
       dos lados. Ahora el front usa el total que ya calcula del catálogo que tiene
       cargado, y este número no existe más. */
    usuarios: { total: usuarios, conCartas, altas7, altasHoy, volvieron, activosHoy, activos7, conApp },
    cartas: { total: cartas, repetidas },
    porDia: porDia.map((f) => ({ dia: f.dia, cuantos: Number(f.cuantos) })),
    tramos: tramos.map((f) => ({ tramo: f.tramo, cuantos: Number(f.cuantos) })),
    /* Cuánta gente hay en total, aparte de cuánta entró en la tabla. El panel lo
       necesita para no mentir cuando la lista viene cortada: los renglones que dicen
       «28 cuentas · 13 con cartas» salen de los números de arriba, no de contar filas
       de la tabla. Es la misma lección del #97 — una tabla que muestra una parte no
       puede ser la fuente de un total. */
    tope: TOPE_GENTE,
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
