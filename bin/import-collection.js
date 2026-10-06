#!/usr/bin/env node
// Mete un coleccion.json en la cuenta de un usuario.
//
//   node bin/import-collection.js angel ../datos/coleccion.json
//
// Sirve para lo que ya tenías cargado antes de que esto fuera un servidor, y para
// recuperar un respaldo a mano. Entiende las formas viejas del archivo.
//
// ES EL CAMINO MÁS PELIGROSO DE TODO EL PROYECTO y durante mucho tiempo fue el que menos
// miraba lo que le daban. Llama a `replaceCollection()` directo, sin pasar por HTTP, así que no
// tenía ninguna de las tres guardas que sí tiene `PUT /api/coleccion`: un `null`, un `[]`
// o el json de cualquier otra cosa se convertían en una colección vacía perfectamente
// válida, borraba todo y contestaba «Listo: 0 cartas». Justo la herramienta que se usa
// para RECUPERAR un respaldo era la que podía perderlo.
//
// Hoy comparte las guardas con la ruta (`validateReplacement`, en collection.js) y tiene su
// propio `normalizeBackup` estricto, que es el equivalente del que corre en el navegador.
import fs from 'node:fs'
import { createDbPool, prepareSchema } from '../src/db.js'
import { replaceCollection, readCollection, normalizeBackup, validateReplacement, countLostCards } from '../src/collection.js'

const [username, filePath] = process.argv.slice(2)

if (!username || !filePath) {
  console.error('uso: node bin/import-collection.js <usuario> <archivo.json>')
  process.exit(1)
}

const pool = createDbPool()
await prepareSchema(pool)

const exitWithError = async (message) => {
  console.error(message)
  await pool.end()
  process.exit(1)
}

const [rows] = await pool.query('SELECT id FROM usuario WHERE usuario = ?', [username])
if (!rows.length)
  await exitWithError(`No existe el usuario "${username}". Registralo primero desde la app.`)

const id = rows[0].id

/* Se lee y se valida el archivo ANTES de mirar lo que hay en la base: si el archivo no
   sirve, no hay nada que preguntar ni ninguna decisión que tomar. */
let raw
try {
  raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
} catch (e) {
  await exitWithError(`No se pudo leer "${filePath}" como json: ${e.message}`)
}

const backup = normalizeBackup(raw)
if (!backup) await exitWithError(`"${filePath}" no parece una copia de una colección. No se tocó nada.`)

const problem = validateReplacement(backup)
if (problem) await exitWithError(`${problem}\nNo se tocó nada.`)

/* Los números antes de preguntar, igual que en la app: «vas a perder 89» se entiende,
   «¿estás seguro?» no dice nada.

   Se cuentan CARTAS y no claves, por lo mismo que `validateReplacement`: una clave con
   cantidad 0 no es una carta, y contándolas el aviso mentía sobre las dos puntas
   —«esta copia trae 2» cuando trae 0, y «perdés 1» cuando perdés 3—. */
const ownedQuantities = (c) => Object.values(c ?? {}).filter((n) => Number(n) > 0)
const currentQuantities = (await readCollection(pool, id)).cantidades
const currentCount = ownedQuantities(currentQuantities).length
const backupCount = ownedQuantities(backup.cantidades).length

/* Clave por clave, y no `currentCount - backupCount`: el porqué está arriba de `countLostCards`, en
   collection.js. Vive allá y no acá para que no haya dos versiones de la misma cuenta —
   que es exactamente cómo esta herramienta se quedó con la fórmula que la app ya había
   refutado. */
const lostCount = countLostCards(currentQuantities, backup.cantidades)

if (currentCount && process.env.DBZ_PISAR !== '1') {
  await exitWithError(
    `Ojo: "${username}" tiene ${currentCount} cartas y esta copia trae ${backupCount}.\n` +
      (lostCount > 0
        ? `Esto las reemplaza y perdés ${lostCount} que la copia no trae.\n`
        : 'Esto las reemplaza, y la copia trae todas las que ya tenés.\n') +
      'Si es lo que querés, corrélo de nuevo con DBZ_PISAR=1.'
  )
}

const insertedCount = await replaceCollection(pool, id, backup)
const duplicateCount = ownedQuantities(backup.cantidades).reduce((a, n) => a + (Number(n) - 1), 0)

console.log(`Listo: ${insertedCount} cartas para "${username}" (${duplicateCount} repetidas).`)
await pool.end()
