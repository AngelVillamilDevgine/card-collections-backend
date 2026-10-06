#!/usr/bin/env node
// Clave provisoria para quien se olvidó la suya.
//
//   node bin/reset-password.js gabrielrivarola43@gmail.com
//
// En producción corre ADENTRO del contenedor, que es donde está la conexión a la base:
//
//   docker exec $(docker ps -qf name=dbz-api_api | head -1) node bin/reset-password.js <usuario>
//
// El recupero de clave es un WhatsApp a Angel (el servidor no puede mandar mail) y hasta
// el 2026-09-30 no había cómo resetearla. Esto le pone una clave provisoria de ocho
// dígitos al azar, la imprime para dictársela, y prende la marca que hace que la app no
// lo deje seguir hasta elegir una propia. No toca sus cartas ni sus sesiones abiertas.
import { createDbPool, prepareSchema } from '../src/db.js'
import { resetPassword } from '../src/auth.js'

const [username] = process.argv.slice(2)
if (!username) {
  console.error('uso: node bin/reset-password.js <usuario>')
  process.exit(1)
}

const pool = createDbPool()
await prepareSchema(pool)

const [rows] = await pool.query('SELECT id, usuario FROM usuario WHERE usuario = ?', [username])
if (!rows.length) {
  console.error(`No existe el usuario "${username}". No se tocó nada.`)
  await pool.end()
  process.exit(1)
}

const temp = await resetPassword(pool, rows[0].id)
await pool.end()
console.log(`Listo: ${rows[0].usuario}`)
console.log(`Clave provisoria: ${temp}`)
console.log('Al entrar, la app le va a pedir que elija una nueva antes de seguir.')
