/* La pasarela: contadores anónimos de lo que pasa ANTES de tener cuenta.
 *
 * `visita` no puede ver ese tramo — tiene FOREIGN KEY a usuario, así que la base no
 * puede guardar una visita sin cuenta ni queriendo. Esto lo cubre con lo mínimo que
 * alcanza: una fila por (día, clave) y un contador. Sin IPs, sin cookies, sin
 * identificadores: son visitas, no personas, y el panel lo dice con esas palabras.
 *
 * LA LISTA BLANCA ES EL DISEÑO. La clave la manda el cliente, así que sin lista un
 * script cualquiera crearía filas a voluntad. Con ella, lo peor que puede hacer quien
 * inunde el endpoint es inflar un contador informativo — filas nuevas no puede crear:
 * el techo de filas es (claves × días), o sea seis por día.
 *
 * Quién manda cada clave:
 *   landing              early.js, al cargar la landing sin sesión
 *   login:hero           «Anotá tus faltantes» del héroe            (?f=hero)
 *   login:closing        «Anotá tus faltantes» del cierre           (?f=closing)
 *   login:hero-acct      «Ya tengo cuenta» del héroe                (?f=hero-acct)
 *   login:closing-acct   «Ya tengo cuenta» del cierre               (?f=closing-acct)
 *   login:direct         el formulario sin venir de la landing (URL directa, marcador)
 *
 * Sin dependencias a propósito: el día llega por parámetro (quien llama ya tiene
 * `todayInArgentina()`) y así esto se prueba solo, sin base y sin reloj. */

export const PULSE_KEYS = new Set([
  'landing',
  'login:hero',
  'login:closing',
  'login:hero-acct',
  'login:closing-acct',
  'login:direct',
])

/* EL VISITANTE ÚNICO. El cuerpo del beacon de la landing es `v1|<vid>|<sesion>|<app>`:
   un ID anónimo de 16 hex que vive en el localStorage del navegador, y dos banderas.
   Personas = navegadores distintos, que es el techo honesto sin invadir a nadie.

   El aparato sale del User-Agent del MISMO pedido, en el servidor: no viaja nada extra
   y la clasificación es gruesa a propósito — para un reparto porcentual alcanza y sobra,
   y no se guarda el UA crudo, que es una huella. */
const VID = /^[a-f0-9]{16}$/

/* LOS ROBOTS NO SON PERSONAS. Googlebot y Bingbot ejecutan JavaScript, así que corren
   `resume.js` y mandan el beacon como cualquiera — y Googlebot en versión teléfono dice
   «Android» en su UA: sin esto contaba como un visitante de Android. Van antes que
   cualquier clasificación. `\bbot\b` con bordes y no `bot` a secas: el celular «CUBOT»
   es un Android de verdad. HeadlessChrome y Lighthouse son automatizaciones (entre ellas,
   las pruebas contra producción de este mismo proyecto). */
const BOT = /\b(bot|crawler|spider)\b|googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|applebot|petalbot|bytespider|ahrefs|semrush|facebookexternalhit|headlesschrome|lighthouse/i

/* EL ORDEN IMPORTA: la Xbox dice «Windows» y los televisores dicen «Linux», así que
   consolas y TV van antes; ChromeOS dice «X11; CrOS», antes que Linux. Hasta el
   2026-09-30 esto sabía cinco nombres y lo demás caía en «otro»: tres de los primeros
   trece visitantes, que no hubo forma de identificar después porque el UA crudo no se
   guarda (ni acá, ni en el log de Traefik, que no conserva cabeceras). Lo pidió Angel:
   «quiero que descubras qué dispositivo es». */
export function deviceOf(ua = '') {
  if (BOT.test(ua)) return 'bot'
  if (/Xbox|PlayStation|Nintendo/i.test(ua)) return 'consola'
  if (/SMART-?TV|Tizen|Web0S|webOS|NetCast|BRAVIA|HbbTV|CrKey|AppleTV|AFT[A-Z]/i.test(ua)) return 'tv'
  if (/iPhone|iPod/.test(ua)) return 'iphone'
  if (/iPad/.test(ua)) return 'ipad'
  if (/Android/.test(ua)) return 'android'
  if (/CrOS/.test(ua)) return 'chromeos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Macintosh/.test(ua)) return 'mac'
  if (/Linux|X11/.test(ua)) return 'linux'
  return 'otro'
}

/* Cada carga de la landing es UNA visita cruda (el contador `landing` de siempre) y,
   si el vid tiene forma, un upsert del visitante y su presencia del día. Un vid
   inventado que no sea 16 hex sólo cuenta la visita cruda.

   Un ROBOT no deja nada: ni carga, ni visitante — el panel cuenta personas. Y un aparato
   que ni con la lista ampliada se reconoce deja su UA EN EL LOG de la API (no en la
   base, que sigue sin guardarlo): así la próxima vez hay con qué identificarlo —
   `docker service logs dbz-api_api 2>&1 | grep 'aparato sin identificar'`. */
export function recordVisit(pool, raw, day, ua, log) {
  const device = deviceOf(ua)
  if (device === 'bot') return Promise.resolve()
  if (device === 'otro') log?.info?.({ ua: String(ua ?? '').slice(0, 300) }, 'aparato sin identificar')
  const [, vid = '', session = '0', standalone = '0'] = String(raw).split('|')
  const jobs = [recordPulse(pool, 'landing', day)]
  if (VID.test(vid)) {
    jobs.push(
      pool
        .query(
          `INSERT INTO visitor (vid, first_day, last_day, visits, with_session, standalone, device)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               last_day = VALUES(last_day),
               visits = visits + 1,
               with_session = GREATEST(with_session, VALUES(with_session)),
               standalone = GREATEST(standalone, VALUES(standalone)),
               device = VALUES(device)`,
          [vid, day, day, session === '1' ? 1 : 0, standalone === '1' ? 1 : 0, device]
        )
        .catch(() => {}),
      pool.query('INSERT IGNORE INTO visitor_day (day, vid) VALUES (?, ?)', [day, vid]).catch(() => {})
    )
  }
  return Promise.all(jobs)
}

/* Sin await en quien llama, igual que `recordUserVisit`: nadie tiene que esperar por una
   estadística. Devuelve la promesa por si los tests quieren esperarla.

   El cuerpo es la clave sola (`login:hero`) o la clave con el visitante anónimo de la
   landing (`login:hero|<vid>`), que es lo que manda el front desde el 2026-10-06. Con el
   visitante, además de sumar la carga, se anota la PERSONA en `visitor_click`: recargar no
   suma dos. Un front viejo manda la clave sola y se cuenta como siempre. */
export function recordPulse(pool, body, day) {
  const [key, vid = ''] = String(body).split('|')
  if (!PULSE_KEYS.has(key)) return null
  const jobs = [
    pool
      .query(
        'INSERT INTO pulse (day, k, n) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1',
        [day, key]
      )
      .catch(() => {}),
  ]
  if (key.startsWith('login:') && VID.test(vid)) {
    jobs.push(pool.query('INSERT IGNORE INTO visitor_click (day, k, vid) VALUES (?, ?, ?)', [day, key, vid]).catch(() => {}))
  }
  return Promise.all(jobs)
}

/* Lo que el panel dibuja. `null` mientras no haya ni una fila: una pasarela que todavía
   no midió nada no es una pasarela de ceros — el panel directamente no la muestra, igual
   que hace con `porColeccion` cuando el back es más viejo que el front. */
export async function funnelSummary(pool, today) {
  const [totals] = await pool.query('SELECT k, SUM(n) n FROM pulse GROUP BY k')
  if (!totals.length) return null

  const byKey = {}
  for (const f of totals) byKey[f.k] = Number(f.n)
  const sum = (...keys) => keys.reduce((a, k) => a + (byKey[k] ?? 0), 0)

  const [[{ since }]] = await pool.query(
    "SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') since FROM pulse"
  )
  /* 62 días de la landing, para que el panel pueda dibujar el mes pasado entero. Los
     días sin nadie no vienen: el panel ya sabe rellenarlos, igual que con `actividad`. */
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') dia, n FROM pulse
      WHERE k = 'landing' AND day > DATE_SUB(?, INTERVAL 62 DAY)
      ORDER BY day`,
    [today]
  )

  /* Las PERSONAS, aparte de las cargas. Totales del resumen por navegador, únicos de
     hoy y por día de `visitor_day`, y el reparto por aparato. Todo junto y con Number()
     porque los SUM() vuelven como texto. */
  const [[unique]] = await pool.query(
    `SELECT COUNT(*) total, COALESCE(SUM(with_session), 0) withSession,
            COALESCE(SUM(standalone), 0) fromApp, COALESCE(SUM(visits), 0) loads
       FROM visitor`
  )
  const [[uniqueToday]] = await pool.query(
    'SELECT COUNT(*) n FROM visitor_day WHERE day = ?', [today]
  )
  const [uniqueDays] = await pool.query(
    `SELECT DATE_FORMAT(day, '%Y-%m-%d') dia, COUNT(*) n FROM visitor_day
      WHERE day > DATE_SUB(?, INTERVAL 62 DAY) GROUP BY day ORDER BY day`,
    [today]
  )
  const [devices] = await pool.query(
    'SELECT device, COUNT(*) n FROM visitor GROUP BY device ORDER BY n DESC'
  )

  return {
    since,
    days: days.map((f) => ({ dia: f.dia, n: Number(f.n) })),
    byKey,
    landing: byKey.landing ?? 0,
    /* Los dos caminos que salen de la landing: a anotarse, y a entrar con cuenta. */
    toSignup: sum('login:hero', 'login:closing'),
    toLogin: sum('login:hero-acct', 'login:closing-acct', 'login:direct'),
    visitors: {
      total: Number(unique.total),
      today: Number(uniqueToday.n),
      withSession: Number(unique.withSession),
      standalone: Number(unique.fromApp),
      days: uniqueDays.map((f) => ({ dia: f.dia, n: Number(f.n) })),
      devices: devices.map((f) => ({ device: f.device, n: Number(f.n) })),
    },
  }
}
