#!/usr/bin/env node
// Mete un coleccion.json en la cuenta de un usuario.
//
//   node bin/importar.js angel ../datos/coleccion.json
//
// Sirve para lo que ya tenías cargado antes de que esto fuera un servidor, y para
// recuperar un respaldo a mano. Entiende las formas viejas del archivo.
//
// ES EL CAMINO MÁS PELIGROSO DE TODO EL PROYECTO y durante mucho tiempo fue el que menos
// miraba lo que le daban. Llama a `reemplazar()` directo, sin pasar por HTTP, así que no
// tenía ninguna de las tres guardas que sí tiene `PUT /api/coleccion`: un `null`, un `[]`
// o el json de cualquier otra cosa se convertían en una colección vacía perfectamente
// válida, borraba todo y contestaba «Listo: 0 cartas». Justo la herramienta que se usa
// para RECUPERAR un respaldo era la que podía perderlo.
//
// Hoy comparte las guardas con la ruta (`revisarReemplazo`, en coleccion.js) y tiene su
// propio `normalizar` estricto, que es el equivalente del que corre en el navegador.
import fs from 'node:fs'
import { conectar, prepararEsquema } from '../src/base.js'
import { reemplazar, leer, normalizarCopia, revisarReemplazo } from '../src/coleccion.js'

const [usuario, ruta] = process.argv.slice(2)

if (!usuario || !ruta) {
  console.error('uso: node bin/importar.js <usuario> <archivo.json>')
  process.exit(1)
}

const pool = conectar()
await prepararEsquema(pool)

const salir = async (mensaje) => {
  console.error(mensaje)
  await pool.end()
  process.exit(1)
}

const [filas] = await pool.query('SELECT id FROM usuario WHERE usuario = ?', [usuario])
if (!filas.length)
  await salir(`No existe el usuario "${usuario}". Registralo primero desde la app.`)

const id = filas[0].id

/* Se lee y se valida el archivo ANTES de mirar lo que hay en la base: si el archivo no
   sirve, no hay nada que preguntar ni ninguna decisión que tomar. */
let crudo
try {
  crudo = JSON.parse(fs.readFileSync(ruta, 'utf8'))
} catch (e) {
  await salir(`No se pudo leer "${ruta}" como json: ${e.message}`)
}

const datos = normalizarCopia(crudo)
if (!datos) await salir(`"${ruta}" no parece una copia de una colección. No se tocó nada.`)

const mal = revisarReemplazo(datos)
if (mal) await salir(`${mal}\nNo se tocó nada.`)

/* Los números antes de preguntar, igual que en la app: «vas a perder 89» se entiende,
   «¿estás seguro?» no dice nada.

   Se cuentan CARTAS y no claves, por lo mismo que `revisarReemplazo`: una clave con
   cantidad 0 no es una carta, y contándolas el aviso mentía sobre las dos puntas
   —«esta copia trae 2» cuando trae 0, y «perdés 1» cuando perdés 3—. */
const cartasDe = (c) => Object.values(c || {}).filter((n) => Number(n) > 0)
const antes = cartasDe((await leer(pool, id)).cantidades).length
const trae = cartasDe(datos.cantidades).length
if (antes && process.env.DBZ_PISAR !== '1') {
  const pierde = antes - trae
  await salir(
    `Ojo: "${usuario}" tiene ${antes} cartas y esta copia trae ${trae}.\n` +
      (pierde > 0 ? `Esto las reemplaza y perdés ${pierde}.\n` : 'Esto las reemplaza.\n') +
      'Si es lo que querés, corrélo de nuevo con DBZ_PISAR=1.'
  )
}

const cartas = await reemplazar(pool, id, datos)
const sobrantes = cartasDe(datos.cantidades).reduce((a, n) => a + (Number(n) - 1), 0)

console.log(`Listo: ${cartas} cartas para "${usuario}" (${sobrantes} repetidas).`)
await pool.end()
