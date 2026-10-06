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
const toLocalTime = (col) => `CONVERT_TZ(${col}, '+00:00', '-03:00')`

import { funnelSummary } from './pulse.js'
import { toProfile } from './profile.js'

/* Cuánta gente entra en la tabla de «uno por uno». No es por el motor —se midió, y lo
   que cuesta es recorrer `carta`, que hay que recorrer igual— sino por lo que viaja:
   con 1000 cuentas la respuesta pasaba de 112 KB, y el panel lo abre alguien desde el
   teléfono. Con 200 son 22 KB. Arriba de eso, la tabla deja de ser una lista que se mira
   y pasa a ser una que se busca, y para eso haría falta otra cosa. */
const MAX_PEOPLE_ROWS = 200

/* Number() a propósito: MySQL devuelve los SUM() como texto, porque son DECIMAL, y
   entonces 2 no es igual a '2' del otro lado. */
async function queryScalar(pool, sql, args = []) {
  const [rows] = await pool.query(sql, args)
  const value = rows[0] ? Object.values(rows[0])[0] : 0
  return value == null ? 0 : Number(value)
}

/* Un día por usuario y nada más. El Map evita repetir el INSERT en cada pedido: se
   pierde al reiniciar y entonces se hace uno de más, que no le duele a nadie.

   Sin await a propósito: nadie espera por una estadística. Si falla, se olvida la
   marca para volver a intentar en el pedido siguiente. */
const visitMarks = new Map()

export const todayInArgentina = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)

/* El Map es de módulo y sobrevive al `DELETE FROM usuario` de los tests. Hoy no rompe
   porque el AUTO_INCREMENT no se reinicia y cada usuario nuevo estrena id, pero el día
   que alguien cambie ese DELETE por un TRUNCATE —que sí lo reinicia— el usuario 1 del
   test siguiente va a encontrar su propia marca del test anterior, la visita no se va a
   anotar nunca y el test se va a colgar esperándola, con un fallo que no dice nada.
   Con esto el que prepara la base puede vaciarlo también, y deja de ser una trampa. */
export const clearVisitMarks = () => visitMarks.clear()

export function recordUserVisit(pool, userId, fromApp = false) {
  const today = todayInArgentina()
  // La marca lleva si vino de la app: si hoy ya entró por el navegador y después abre
  // la app, la fila tiene que pasar a contar como app igual.
  const mark = `${today}:${fromApp ? 1 : 0}`
  if (visitMarks.get(userId) === mark) return
  if (visitMarks.size > 5000) visitMarks.clear() // que no crezca para siempre
  visitMarks.set(userId, mark)
  // Devuelve la promesa por si alguien quiere esperarla (los tests); el servidor no.
  return pool
    .query(
      `INSERT INTO visita (usuario_id, dia, app) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE app = GREATEST(app, VALUES(app))`,
      [userId, today, fromApp ? 1 : 0]
    )
    .catch(() => visitMarks.delete(userId))
}

/* Lo que escriben el respaldo y el despliegue, que corren fuera de la app. Se devuelve
   crudo con su fecha: quién decide si "hace tres días" es un problema es el panel, no
   esto. */
export async function readHealth(pool) {
  const [rows] = await pool.query(
    `SELECT clave, valor,
            DATE_FORMAT(${toLocalTime('actualizado')}, '%Y-%m-%d %H:%i') actualizado,
            TIMESTAMPDIFF(MINUTE, actualizado, UTC_TIMESTAMP()) hace
       FROM salud`
  )
  const result = {}
  for (const f of rows) {
    let value = f.valor
    try { value = JSON.parse(f.valor) } catch { /* si no es json, va el texto */ }
    // `hace` en minutos: que el panel no tenga que hacer cuentas con husos.
    result[f.clave] = { valor: value, actualizado: f.actualizado, hace: Number(f.hace) }
  }
  return result
}

/* QUIÉN DICE QUÉ ES UNA COLECCIÓN: el front, no el backend.
 *
 * El catálogo vive en `frontend/public/data/` y se edita sin recompilar nada, así que un
 * `clave LIKE 'ley-%'` escrito acá sería el mismo error que se corrigió con el total de
 * 1936: el día que cambie, el panel sigue contestando con la versión vieja y ningún test
 * puede agarrarlo porque ninguno ve los dos lados. Así que el front manda qué prefijos son
 * de cada colección y acá sólo se agrupa.
 *
 * Viene del cliente, así que se valida entero antes de tocar el SQL: cada prefijo con la
 * misma forma que acepta `isValidCardKey`, y con techo. Los valores van BINDEADOS; lo único
 * que se construye es la cantidad de signos de pregunta.
 *
 * Si no viene, o viene mal, se devuelve `null` y el panel sigue andando sin partir nada:
 * un front viejo contra un back nuevo tiene que seguir funcionando. */
const EXPANSION_ID_PATTERN = /^[a-z0-9-]{1,34}$/
const MAX_COLLECTIONS = 10
const MAX_EXPANSION_IDS = 200

export function parseCollections(text) {
  if (!text) return null
  let raw
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result = []
  let expansionIdCount = 0
  for (const [id, expansionIds] of Object.entries(raw)) {
    if (!EXPANSION_ID_PATTERN.test(id) || !Array.isArray(expansionIds) || !expansionIds.length) return null
    if (!expansionIds.every((p) => typeof p === 'string' && EXPANSION_ID_PATTERN.test(p))) return null
    expansionIdCount += expansionIds.length
    result.push({ id, expansionIds })
  }
  if (!result.length || result.length > MAX_COLLECTIONS || expansionIdCount > MAX_EXPANSION_IDS) return null
  return result
}

/* DE QUÉ COLECCIÓN ES UN TRAMO, Y POR QUÉ NO ALCANZA CON COMPARARLO ENTERO.
 *
 * La parte de la clave anterior a los dos puntos es el id de la expansión —`ley-6`— o ese
 * id con el sufijo de una variante —`ley-6-dor`—. Comparando por igualdad, las filas de
 * variante caen fuera de toda colección: medido contra producción, las once que Angel
 * tenía cargadas en dorado, plata, naranja y cyan desaparecían del reparto (8026 + 27 =
 * 8053 contra un total de 8064) **y el panel las anunciaba como «de un catálogo viejo»,
 * con el pie ofreciendo borrarlas**. Un cartel que invita a borrar cartas buenas.
 *
 * Se elige el prefijo MÁS LARGO que coincide, por si alguna vez un id es prefijo de otro. */
export function collectionOf(keyPrefix, collections) {
  return matchExpansion(keyPrefix, collections)?.col ?? null
}

/* Lo mismo, pero devolviendo TAMBIÉN el prefijo que ganó, que es lo que hace falta para
   saber a qué HUECO apunta una fila de variante: `ley-6-dor` gana con `ley-6`, así que el
   hueco de `ley-6-dor:824` es `ley-6:824`. */
export function matchExpansion(keyPrefix, collections) {
  let best = null
  for (const c of collections) {
    for (const p of c.expansionIds) {
      if (keyPrefix !== p && !keyPrefix.startsWith(p + '-')) continue
      if (!best || p.length > best.expansionId.length) best = { col: c.id, expansionId: p }
    }
  }
  return best
}

/* Cuántas cartas tiene cada persona EN CADA COLECCIÓN. Sin esto, la columna «Álbum»
   divide las filas de alguien por la suma de los dos catálogos: el que tiene Cromeros
   entero —1936 de 1936— se dibuja con 64%, porque el denominador son 3033.
 *
 * El reparto se hace en JS y no en un CASE armado con los prefijos del cliente. Sale más
 * simple, no construye SQL con nada que venga de afuera, y es lo único que puede hacer
 * bien lo de los sufijos de variante. La consulta trae una fila por (persona, tramo): hoy
 * son unas 500, y con el techo de 200 personas no pasa de unos miles. */
async function countByUserAndCollection(pool, collections) {
  if (!collections) return null
  const [rawRows] = await pool.query(
    `SELECT usuario_id, SUBSTRING_INDEX(clave, ':', 1) keyPrefix,
            COUNT(*) cartas, COALESCE(SUM(cantidad - 1), 0) repetidas
       FROM carta GROUP BY usuario_id, keyPrefix`
  )
  const rows = rawRows.map((f) => {
    const m = matchExpansion(f.keyPrefix, collections)
    return { ...f, col: m?.col ?? '', expansionId: m?.expansionId ?? '' }
  })
  /* SE SUMA, NO SE PISA. La consulta trae una fila por (persona, TRAMO) y una colección
     tiene muchos tramos: Cromeros son dieciséis. Asignando en vez de acumular, de cada
     persona sobrevivía un solo tramo — medido contra producción, alguien con 1842 cartas
     se dibujaba con 123, que son las de su último tramo. */
  const byUser = new Map()
  for (const f of rows) {
    if (!f.col) continue
    if (!byUser.has(f.usuario_id)) byUser.set(f.usuario_id, {})
    const userTotals = byUser.get(f.usuario_id)
    const previous = userTotals[f.col] ?? { cartas: 0, repetidas: 0, huecos: 0 }
    userTotals[f.col] = {
      cartas: previous.cartas + Number(f.cartas),
      repetidas: previous.repetidas + Number(f.repetidas),
      /* LOS HUECOS NO SON LAS FILAS, y confundirlos era el «% medio gagá» que Angel vio.
         Una variante es una fila propia —`ley-6-dor:824`— pero NO es un hueco del álbum:
         el hueco es la 824, y Leyenda tiene 1097. Dividiendo filas por huecos el panel
         mezclaba dos unidades: arriba contaba variantes y abajo faltantes, podía pasarse
         de 100%, y el tope que lo recortaba lo disfrazaba de «álbum completo».

         Acá cada fila de un tramo BASE es un hueco, uno a uno. Las de variante se suman
         aparte, más abajo, porque hay que mirar si el hueco ya estaba contado. */
      huecos: previous.huecos + (f.expansionId === f.keyPrefix ? Number(f.cartas) : 0),
    }
  }

  /* LAS FILAS DE VARIANTE, una por una, que son las únicas que no se pueden contar en
     bloque: dos fondos de la misma carta son UN hueco, y si además tenés la base ese hueco
     ya está contado. Se traen sólo ésas —en producción son 13 de 8107— así que esto no
     crece con la colección, crece con cuántas variantes carga la gente.

     La consulta usa los prefijos como PARÁMETROS, no armando SQL con ellos: `parseCollections`
     ya los valida uno por uno, pero no construir texto SQL con lo que manda el cliente es
     más barato que confiar en la validación. */
  const expansionIds = collections.flatMap((c) => c.expansionIds)
  const [variantRows] = await pool.query(
    `SELECT usuario_id, clave FROM carta
      WHERE SUBSTRING_INDEX(clave, ':', 1) NOT IN (?)`, [expansionIds]
  )

  /* De cada una: a qué hueco apunta. Un Set por persona, así dos fondos de la misma carta
     cuentan una vez. */
  const variantSlotsByUser = new Map()   // usuario -> Map(col -> Set(hueco))
  const slotsToCheck = []                // los que habría que mirar si ya tienen la base
  for (const f of variantRows) {
    const colonIndex = f.clave.lastIndexOf(':')
    if (colonIndex < 0) continue
    const m = matchExpansion(f.clave.slice(0, colonIndex), collections)
    if (!m) continue
    const slot = `${m.expansionId}:${f.clave.slice(colonIndex + 1)}`
    if (!variantSlotsByUser.has(f.usuario_id)) variantSlotsByUser.set(f.usuario_id, new Map())
    const userSlots = variantSlotsByUser.get(f.usuario_id)
    if (!userSlots.has(m.col)) userSlots.set(m.col, new Set())
    if (userSlots.get(m.col).has(slot)) continue
    userSlots.get(m.col).add(slot)
    slotsToCheck.push([f.usuario_id, slot])
  }

  /* Y cuáles de esos huecos YA los cubre una fila base. Sin esto, tener la 824 y además la
     824 dorada contaría dos huecos y el porcentaje volvería a pasarse. Es un `IN` sobre
     pares concretos: tan chico como la lista de arriba. */
  const slotsWithBase = new Set()
  if (slotsToCheck.length) {
    const [baseRows] = await pool.query(
      'SELECT usuario_id, clave FROM carta WHERE (usuario_id, clave) IN (?)', [slotsToCheck]
    )
    for (const f of baseRows) slotsWithBase.add(`${f.usuario_id}|${f.clave}`)
  }
  for (const [userId, userSlots] of variantSlotsByUser) {
    for (const [col, slots] of userSlots) {
      const newSlotCount = [...slots].filter((h) => !slotsWithBase.has(`${userId}|${h}`)).length
      if (!newSlotCount) continue
      if (!byUser.has(userId)) byUser.set(userId, {})
      const userTotals = byUser.get(userId)
      const previous = userTotals[col] ?? { cartas: 0, repetidas: 0, huecos: 0 }
      userTotals[col] = { ...previous, huecos: previous.huecos + newSlotCount }
    }
  }

  /* Y el total por colección sale de ese mismo mapa, que ya tiene UNA entrada por persona:
     contando filas, «personas» daba los dieciséis tramos de cada uno. No sale de sumar la
     tabla de «uno por uno», que viene cortada en 200 y mentiría — es la lección del #97. */
  const totals = new Map()
  for (const userTotals of byUser.values()) {
    for (const [col, v] of Object.entries(userTotals)) {
      const t = totals.get(col) ?? { col, cartas: 0, repetidas: 0, huecos: 0, personas: 0 }
      t.cartas += v.cartas
      t.repetidas += v.repetidas
      t.huecos += v.huecos
      t.personas += 1
      totals.set(col, t)
    }
  }
  return { byUser, totals: [...totals.values()] }
}

/* ---------- LOS PERÍODOS DEL PANEL: hoy, 7 días, este mes, el mes pasado ----------
 *
 * Lo pidió Angel el 2026-09-29: «todo el dashboard filtrado por 1 día, 1 semana, mes
 * actual, mes pasado». El filtro es un conjunto CERRADO, así que el servidor precalcula
 * el paquete de cada período.
 *
 * Los únicos por período NO salen de sumar los diarios: la misma persona en tres días
 * sumaría tres. Cada paquete cuenta con COUNT(DISTINCT) sobre su rango.
 *
 * HUBO ADEMÁS UN «ANTES» POR PERÍODO (el espejo equivalente: ayer, la semana previa, el
 * mismo tramo del mes pasado capado al último día) y Angel lo sacó el 2026-09-30: «no
 * quiero gastar procesamiento al pedo» — eran cuatro paquetes extra de COUNT(DISTINCT)
 * por apertura del panel. Si vuelve, la aritmética del mismo-tramo está en el git log,
 * con sus tests del 31 de marzo contra el 28 de febrero.
 *
 * Fechas como texto YYYY-MM-DD en hora local (la de `todayInArgentina`), aritmética a mediodía UTC
 * para que ningún huso la corra de día. */
const dayToDate = (day) => new Date(`${day}T12:00:00Z`)
const dateToDay = (date) => date.toISOString().slice(0, 10)
const addDays = (day, n) => { const date = dayToDate(day); date.setUTCDate(date.getUTCDate() + n); return dateToDay(date) }
const monthStart = (s) => s.slice(0, 8) + '01'

export function periodRanges(today) {
  const thisMonthStart = monthStart(today)
  const prevMonthEnd = addDays(thisMonthStart, -1)
  const prevMonthStart = monthStart(prevMonthEnd)
  return {
    hoy: { from: today, to: today },
    semana: { from: addDays(today, -6), to: today },
    mes: { from: thisMonthStart, to: today },
    mesPasado: { from: prevMonthStart, to: prevMonthEnd },
  }
}

/* La estación que sigue a «Registros»: de los que se registraron en el período, cuántos
   tienen HOY más de estas cartas marcadas. Lo pidió Angel: «si carga 1 o ninguna no me
   interesa a fines prácticos». Cuenta cartas distintas (filas), no copias: tener la 5 tres
   veces no es haber cargado tres cartas. */
export const LOADED_MIN_CARDS = 20

/* El paquete de un rango: todo lo que el panel muestra filtrado. `moved` usa
   `carta.marked_at`, que las filas anteriores a su migración tienen en NULL — esas
   quedan afuera de todos los rangos por igual, que es lo honesto que se puede. */
async function rangePack(pool, from, to) {
  const [visitors, visitorsNew, signups, signupsLoaded, [[usage]], [pulses], [moved], [devices]] = await Promise.all([
    queryScalar(pool, 'SELECT COUNT(DISTINCT vid) FROM visitor_day WHERE day BETWEEN ? AND ?', [from, to]),
    queryScalar(pool, 'SELECT COUNT(*) FROM visitor WHERE first_day BETWEEN ? AND ?', [from, to]),
    queryScalar(pool, `SELECT COUNT(*) FROM usuario WHERE DATE(${toLocalTime('creado')}) BETWEEN ? AND ?`, [from, to]),
    /* La subconsulta cae sobre la primaria de `carta`, que empieza por `usuario_id`: es
       contar el índice de unas pocas cuentas, no recorrer la tabla. */
    queryScalar(pool,
      `SELECT COUNT(*) FROM usuario u
        WHERE DATE(${toLocalTime('u.creado')}) BETWEEN ? AND ?
          AND (SELECT COUNT(*) FROM carta c WHERE c.usuario_id = u.id) > ?`,
      [from, to, LOADED_MIN_CARDS]),
    /* El uso, partido por la bandera del día: `app=1` es «ese día entró como app
       instalada al menos una vez». Web y app pueden SOLAPARSE (lunes navegador, martes
       app), así que las dos no tienen por qué sumar el total — el total sigue en
       `usedApp` para la conversión de «movieron cartas». Lo pidió Angel: una estación
       para la página y otra para la app. */
    pool.query(
      `SELECT COUNT(DISTINCT usuario_id) total,
              COUNT(DISTINCT CASE WHEN app = 0 THEN usuario_id END) web,
              COUNT(DISTINCT CASE WHEN app = 1 THEN usuario_id END) installed
         FROM visita WHERE dia BETWEEN ? AND ?`,
      [from, to]
    ),
    pool.query('SELECT k, SUM(n) n FROM pulse WHERE day BETWEEN ? AND ? GROUP BY k', [from, to]),
    pool.query(
      `SELECT COUNT(DISTINCT usuario_id) gente, COUNT(*) cartas FROM carta
        WHERE marked_at IS NOT NULL AND DATE(${toLocalTime('marked_at')}) BETWEEN ? AND ?`,
      [from, to]
    ),
    pool.query(
      `SELECT v.device, COUNT(DISTINCT vd.vid) n
         FROM visitor_day vd JOIN visitor v ON v.vid = vd.vid
        WHERE vd.day BETWEEN ? AND ? GROUP BY v.device ORDER BY n DESC`,
      [from, to]
    ),
  ])
  const byKey = {}
  for (const f of pulses) byKey[f.k] = Number(f.n)
  const sum = (...ks) => ks.reduce((a, k) => a + (byKey[k] ?? 0), 0)
  return {
    desde: from, hasta: to,
    visitors, visitorsNew, signups, signupsLoaded,
    usedApp: Number(usage.total),
    usedWeb: Number(usage.web),
    usedInstalled: Number(usage.installed),
    landing: byKey.landing ?? 0,
    toSignup: sum('login:hero', 'login:closing'),
    toLogin: sum('login:hero-acct', 'login:closing-acct', 'login:direct'),
    moved: { gente: Number(moved[0]?.gente ?? 0), cartas: Number(moved[0]?.cartas ?? 0) },
    devices: devices.map((f) => ({ device: f.device, n: Number(f.n) })),
  }
}

export async function periodSummaries(pool, today) {
  const ranges = periodRanges(today)
  const out = {}
  for (const [name, r] of Object.entries(ranges)) {
    out[name] = await rangePack(pool, r.from, r.to)
  }
  return out
}

export async function buildAdminSummary(pool, collections = null) {
  const [userCount, usersWithCards, cardCount, duplicateCount, signupsLast7Days, signupsToday, returningUsers, activeToday, activeLast7Days, usersWithApp] =
    await Promise.all([
      queryScalar(pool, 'SELECT COUNT(*) FROM usuario'),
      queryScalar(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM carta'),
      queryScalar(pool, 'SELECT COUNT(*) FROM carta'),
      queryScalar(pool, 'SELECT COALESCE(SUM(cantidad - 1), 0) FROM carta'),
      /* Por día LOCAL y no por ventana rodante de UTC. `creado > NOW() - INTERVAL 7 DAY`
         cuenta las últimas 168 horas contadas desde este instante, pero todo lo demás
         del panel agrupa por día de Argentina: los dos números no eran comparables, y
         el más viejo salía siempre recortado por las horas que ya habían pasado hoy. */
      queryScalar(pool, `SELECT COUNT(*) FROM usuario
                  WHERE DATE(${toLocalTime('creado')}) > DATE_SUB(?, INTERVAL 7 DAY)`, [todayInArgentina()]),
      queryScalar(pool, `SELECT COUNT(*) FROM usuario WHERE DATE(${toLocalTime('creado')}) = DATE(${toLocalTime('NOW()')})`),
      // Volver otro día es la señal de que la app sirve para algo. Se cuenta con
      // `visita`, no con `sesion`: la sesión dura 30 días, así que el que entra una
      // vez y la usa todos los días no crea ninguna sesión nueva.
      queryScalar(pool, `SELECT COUNT(*) FROM (
                   SELECT usuario_id FROM visita GROUP BY usuario_id
                    HAVING COUNT(*) > 1) t`),
      queryScalar(pool, 'SELECT COUNT(*) FROM visita WHERE dia = ?', [todayInArgentina()]),
      queryScalar(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM visita WHERE dia > DATE_SUB(?, INTERVAL 7 DAY)', [todayInArgentina()]),
      // La instalaron en el teléfono. Es el paso que más hace volver a la gente.
      queryScalar(pool, 'SELECT COUNT(DISTINCT usuario_id) FROM visita WHERE app = 1'),
    ])

  /* 62 días y no 14: alcanza para dibujar el mes pasado entero con margen. Quien quiera
     14 recorta — el eje lo arma el panel. */
  const [signupsByDay] = await pool.query(
    `SELECT DATE_FORMAT(${toLocalTime('creado')}, '%Y-%m-%d') dia, COUNT(*) cuantos FROM usuario
      WHERE DATE(${toLocalTime('creado')}) > DATE_SUB(?, INTERVAL 62 DAY)
      GROUP BY dia ORDER BY dia`,
    [todayInArgentina()]
  )

  /* LAS COHORTES, que es lo que un total acumulado no puede decir. `volvieron` mezcla a
     quien se anotó hace tres semanas con quien se anotó ayer, y mientras la app crece ese
     promedio baja solo aunque nada empeore — porque cada semana entra gente que todavía no
     tuvo tiempo de volver. Agrupado por semana de alta, en cambio, se puede comparar una
     semana contra otra y ver si lo que cambiamos sirvió.

     La semana arranca el lunes (WEEKDAY() devuelve 0 el lunes) y en hora de Argentina,
     igual que todo lo demás del panel. */
  const [cohorts] = await pool.query(
    `SELECT DATE_FORMAT(DATE_SUB(DATE(${toLocalTime('u.creado')}),
              INTERVAL WEEKDAY(${toLocalTime('u.creado')}) DAY), '%Y-%m-%d') semana,
            COUNT(*) gente,
            SUM(EXISTS(SELECT 1 FROM carta c WHERE c.usuario_id = u.id)) cargaron,
            SUM((SELECT COUNT(*) FROM visita v WHERE v.usuario_id = u.id) > 1) volvieron
       FROM usuario u
      WHERE DATE(${toLocalTime('u.creado')}) > DATE_SUB(?, INTERVAL 56 DAY)
      GROUP BY semana ORDER BY semana`,
    [todayInArgentina()]
  )

  /* EL PULSO: cuánta gente USA la app cada día. El gráfico que había es de ALTAS, que es
     otra cosa — mide cuánta gente llega, no cuánta se queda. Con la app creciendo, las
     altas hacen un pico el día que se comparte el enlace y después nada; las visitas
     dicen si alguien sigue ahí al día siguiente. */
  const [activityByDay] = await pool.query(
    `SELECT DATE_FORMAT(dia, '%Y-%m-%d') dia, COUNT(*) personas, COALESCE(SUM(app), 0) porApp
       FROM visita WHERE dia > DATE_SUB(?, INTERVAL 62 DAY)
      GROUP BY dia ORDER BY dia`,
    [todayInArgentina()]
  )

  /* QUÉ SE ESTÁ USANDO, por tramo del álbum, SIN que el backend sepa qué es cada tramo.
     Devuelve la parte de la clave anterior a los dos puntos y listo; agrupar esos tramos
     en colecciones lo hace el front, que es el único lado que conoce el catálogo. Poner
     acá un `clave LIKE 'ley-%'` sería repetir el error que se corrigió con el total de
     1936: el catálogo se edita sin recompilar y el backend se quedaría con la versión
     vieja, mintiendo en silencio. */
  const [rowsByKeyPrefix] = await pool.query(
    `SELECT SUBSTRING_INDEX(clave, ':', 1) tramo,
            COUNT(*) filas, COUNT(DISTINCT usuario_id) personas
       FROM carta GROUP BY tramo ORDER BY filas DESC`
  )

  const [cardCountBuckets] = await pool.query(
    `SELECT CASE WHEN n = 0 THEN 'Ninguna'
                 WHEN n < 10 THEN '1 a 9'
                 WHEN n < 100 THEN '10 a 99'
                 WHEN n < 500 THEN '100 a 499'
                 ELSE '500 o más' END tramo,
            COUNT(*) cuantos, MIN(n) sortKey
       FROM (SELECT u.id, COUNT(c.clave) n
               FROM usuario u LEFT JOIN carta c ON c.usuario_id = u.id
              GROUP BY u.id) x
      GROUP BY tramo ORDER BY sortKey`
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
  const [people] = await pool.query(
    `SELECT u.id,
            u.usuario,
            DATE_FORMAT(${toLocalTime('u.creado')}, '%Y-%m-%d') alta,
            COALESCE(k.cartas, 0) cartas,
            COALESCE(k.repetidas, 0) repetidas,
            DATE_FORMAT(v.ultima, '%Y-%m-%d') ultima,
            COALESCE(v.dias, 0) dias,
            COALESCE(v.app, 0) app,
            u.must_change, u.first_name, u.middle_name, u.last_name, u.whatsapp, u.province
       FROM usuario u
       LEFT JOIN (SELECT usuario_id, COUNT(*) cartas, COALESCE(SUM(cantidad - 1), 0) repetidas
                    FROM carta GROUP BY usuario_id) k ON k.usuario_id = u.id
       LEFT JOIN (SELECT usuario_id, MAX(dia) ultima, COUNT(*) dias, MAX(app) app
                    FROM visita GROUP BY usuario_id) v ON v.usuario_id = u.id
      ORDER BY cartas DESC, u.creado DESC
      LIMIT ?`,
    [MAX_PEOPLE_ROWS]
  )

  const collectionSplit = await countByUserAndCollection(pool, collections)
  const byUser = collectionSplit?.byUser ?? null

  /* LA PASARELA, si ya midió algo. Los contadores anónimos arrancaron el 2026-09-29, así
     que el «se anotaron» de la pasarela se corta en su propio arranque: comparar visitas
     de hoy contra las 42 altas históricas daría una conversión absurda. `signups` son las
     altas DESDE que la pasarela existe — mismo día local que todo lo demás. */
  const funnel = await funnelSummary(pool, todayInArgentina())
  if (funnel) {
    funnel.signups = await queryScalar(
      pool,
      `SELECT COUNT(*) FROM usuario WHERE DATE(${toLocalTime('creado')}) >= ?`,
      [funnel.since]
    )
  }

  return {
    salud: await readHealth(pool),
    /* Los cuatro períodos del filtro, cada uno con su «antes». Un front viejo lo ignora. */
    periodos: await periodSummaries(pool, todayInArgentina()),
    /* Acá había un `total: 1936` escrito a mano, que es el tamaño del catálogo. El
       catálogo vive en el front y se edita sin recompilar nada, así que el día que
       cambiara, el panel iba a seguir calculando los porcentajes de la columna «Álbum»
       contra un número viejo — mintiendo en silencio, porque ningún test puede ver los
       dos lados. Ahora el front usa el total que ya calcula del catálogo que tiene
       cargado, y este número no existe más. */
    usuarios: {
      total: userCount,
      conCartas: usersWithCards,
      altas7: signupsLast7Days,
      altasHoy: signupsToday,
      volvieron: returningUsers,
      activosHoy: activeToday,
      activos7: activeLast7Days,
      conApp: usersWithApp,
    },
    cartas: { total: cardCount, repetidas: duplicateCount },
    porDia: signupsByDay.map((f) => ({ dia: f.dia, cuantos: Number(f.cuantos) })),
    actividad: activityByDay.map((f) => ({ dia: f.dia, personas: Number(f.personas), porApp: Number(f.porApp) })),
    cohortes: cohorts.map((f) => ({
      semana: f.semana,
      gente: Number(f.gente),
      cargaron: Number(f.cargaron),
      volvieron: Number(f.volvieron),
    })),
    porTramo: rowsByKeyPrefix.map((f) => ({
      tramo: f.tramo,
      filas: Number(f.filas),
      personas: Number(f.personas),
    })),
    tramos: cardCountBuckets.map((f) => ({ tramo: f.tramo, cuantos: Number(f.cuantos) })),
    /* Cuánta gente hay en total, aparte de cuánta entró en la tabla. El panel lo
       necesita para no mentir cuando la lista viene cortada: los renglones que dicen
       «28 cuentas · 13 con cartas» salen de los números de arriba, no de contar filas
       de la tabla. Es la misma lección del #97 — una tabla que muestra una parte no
       puede ser la fuente de un total. */
    /* `null` mientras no haya ni una fila de pulso: el panel no dibuja una pasarela de
       ceros, igual que no parte por colección cuando el back es más viejo que el front. */
    funnel,
    tope: MAX_PEOPLE_ROWS,
    /* Qué colecciones se pidieron, para que el front no tenga que adivinar si la
       respuesta viene partida o no (un back viejo no la parte). */
    colecciones: collections ? collections.map((c) => c.id) : null,
    porColeccion: collectionSplit?.totals ?? null,
    gente: people.map((f) => ({
      usuario: f.usuario,
      alta: f.alta,
      cartas: Number(f.cartas),
      repetidas: Number(f.repetidas),
      ultima: f.ultima ?? null,
      dias: Number(f.dias),
      app: Number(f.app) === 1,
      porColeccion: byUser?.get(f.id) ?? null,
      /* Lo que la ficha del usuario muestra en el panel: su perfil, si lo cargó, y si
         tiene una clave provisoria que todavía no cambió. Mismo formato que /api/profile. */
      profile: toProfile(f),
      mustChange: Number(f.must_change) === 1,
    })),
  }
}
