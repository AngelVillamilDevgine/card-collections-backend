// Los cuatro períodos del panel y sus «antes». Lo delicado está en dos lugares: la
// aritmética de meses (que no puede correrse un día por el huso, ni comparar 29 días
// contra 31) y que los únicos por período salgan de COUNT(DISTINCT) — la misma persona
// en tres días del rango tiene que contar UNA vez.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createDbPool, prepareSchema } from '../src/db.js'
import { periodRanges, periodSummaries, buildAdminSummary, clearVisitMarks, todayInArgentina, LOADED_MIN_CARDS } from '../src/stats.js'
import { recordVisit } from '../src/pulse.js'

const TEST_DB_URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'

let pool

before(async () => {
  pool = createDbPool(TEST_DB_URL)
  await prepareSchema(pool)
})

after(async () => { await pool?.end() })

beforeEach(async () => {
  await pool.query('DELETE FROM pulse')
  await pool.query('DELETE FROM visitor')
  await pool.query('DELETE FROM visitor_day')
  await pool.query('DELETE FROM usuario')
  clearVisitMarks()
})

test('los rangos: semana de 7, mes desde el 1, y el mes pasado entero', () => {
  const r = periodRanges('2026-09-29')
  assert.deepEqual(r.hoy, { from: '2026-09-29', to: '2026-09-29' })
  assert.deepEqual(r.semana, { from: '2026-09-23', to: '2026-09-29' })
  assert.equal(r.mes.from, '2026-09-01')
  assert.equal(r.mes.to, '2026-09-29')
  assert.deepEqual(r.mesPasado, { from: '2026-08-01', to: '2026-08-31' })
})

test('cruzando enero, el mes pasado es diciembre del año anterior', () => {
  const r = periodRanges('2026-01-15')
  assert.equal(r.mesPasado.from, '2025-12-01')
  assert.equal(r.mesPasado.to, '2025-12-31')
})

test('la misma persona en tres días de la semana cuenta UNA vez en el período', async () => {
  const today = todayInArgentina()
  const VID = 'aaaa111122223333'
  /* Tres días distintos del rango de la semana, mismo navegador. `recordVisit` sólo
     anota hoy, así que los otros dos días se siembran directo. */
  await recordVisit(pool, `v1|${VID}|0|0`, today, 'Android')
  for (const daysBack of [1, 2]) {
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - daysBack)
    await pool.query('INSERT IGNORE INTO visitor_day (day, vid) VALUES (?, ?)', [d.toISOString().slice(0, 10), VID])
  }
  const p = await periodSummaries(pool, today)
  assert.equal(p.semana.visitors, 1)
  assert.equal(p.hoy.visitors, 1)
})

test('el paquete junta altas, uso, movimiento de cartas y aparatos del rango', async () => {
  const today = todayInArgentina()
  await recordVisit(pool, 'v1|bbbb111122223333|0|0', today, 'iPhone OS')
  const [u] = await pool.query('INSERT INTO usuario (usuario, hash) VALUES (?, ?)', ['p@e.com', 'x'])
  await pool.query('INSERT INTO visita (usuario_id, dia) VALUES (?, ?)', [u.insertId, today])
  /* Y un segundo que ese día entró como app instalada: el uso se parte por la bandera. */
  const [u2] = await pool.query('INSERT INTO usuario (usuario, hash) VALUES (?, ?)', ['q@e.com', 'x'])
  await pool.query('INSERT INTO visita (usuario_id, dia, app) VALUES (?, ?, 1)', [u2.insertId, today])
  // `marked_at` se llena solo con el timestamp de ahora: cae en el rango de hoy.
  await pool.query('INSERT INTO carta (usuario_id, clave, cantidad) VALUES (?, ?, 1)', [u.insertId, 'exp-1:1'])
  const p = await periodSummaries(pool, today)
  assert.equal(p.hoy.signups, 2)
  assert.equal(p.hoy.usedApp, 2)
  assert.equal(p.hoy.usedWeb, 1)
  assert.equal(p.hoy.usedInstalled, 1)
  assert.deepEqual(p.hoy.moved, { gente: 1, cartas: 1 })
  assert.deepEqual(p.hoy.devices, [{ device: 'iphone', n: 1 }])
  assert.equal(p.hoy.visitorsNew, 1)
})

test('«cargaron más de 20»: de los registrados en el período, los que tienen MÁS de 20 cartas distintas', async () => {
  const today = todayInArgentina()
  const ids = []
  for (const name of ['a@e.com', 'b@e.com', 'c@e.com', 'd@e.com']) {
    const [u] = await pool.query('INSERT INTO usuario (usuario, hash) VALUES (?, ?)', [name, 'x'])
    ids.push(u.insertId)
  }
  const mark = (id, n, quantity = 1) => {
    const rows = Array.from({ length: n }, (_, i) => [id, `exp-1:${i + 1}`, quantity])
    return n ? pool.query('INSERT INTO carta (usuario_id, clave, cantidad) VALUES ?', [rows]) : null
  }
  await mark(ids[0], LOADED_MIN_CARDS + 1)   // 21: cuenta
  await mark(ids[1], LOADED_MIN_CARDS)       // 20 justas: no es «más de 20»
  await mark(ids[2], 3, 9)                   // 3 cartas con 9 copias cada una: no son 27 cartas
  // ids[3], ninguna
  const p = await periodSummaries(pool, today)
  assert.equal(p.hoy.signups, 4)
  assert.equal(p.hoy.signupsLoaded, 1)
  assert.equal(p.semana.signupsLoaded, 1, 'el mismo registro cae también en la semana')
})

test('el resumen del panel lleva los cuatro períodos', async () => {
  const d = await buildAdminSummary(pool)
  for (const k of ['hoy', 'semana', 'mes', 'mesPasado']) {
    assert.ok(d.periodos[k], `falta el período ${k}`)
  }
})
