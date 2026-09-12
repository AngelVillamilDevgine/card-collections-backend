#!/usr/bin/env node
// Mete un coleccion.json en la cuenta de un usuario.
//
//   node bin/importar.js angel ../datos/coleccion.json
//
// Sirve para lo que ya tenías cargado antes de que esto fuera un servidor, y para
// recuperar un respaldo a mano. Entiende las formas viejas del archivo, igual que
// las entendía normalizar() en el front.
import fs from 'node:fs'
import { abrir } from '../src/base.js'
import { reemplazar, leer } from '../src/coleccion.js'

const [usuario, ruta] = process.argv.slice(2)

if (!usuario || !ruta) {
  console.error('uso: node bin/importar.js <usuario> <archivo.json>')
  process.exit(1)
}

function normalizar(datos) {
  if (!datos || typeof datos !== 'object') return { estados: {}, cantidades: {} }
  const estados = datos.estados ?? (datos.cantidades ? {} : datos)
  if (datos.cantidades) return { estados, cantidades: datos.cantidades }
  // Forma vieja: "repetidas" contaba las que sobraban, no las que tenías.
  const cantidades = {}
  for (const clave of Object.keys(estados)) cantidades[clave] = 1 + (datos.repetidas?.[clave] ?? 0)
  return { estados, cantidades }
}

const base = abrir()
const fila = base.prepare('SELECT id FROM usuario WHERE usuario = ?').get(usuario)
if (!fila) {
  console.error(`No existe el usuario "${usuario}". Registralo primero desde la app.`)
  process.exit(1)
}

const antes = Object.keys(leer(base, fila.id).cantidades).length
if (antes) {
  console.error(`Ojo: "${usuario}" ya tiene ${antes} cartas y esto las reemplaza.`)
  if (process.env.DBZ_PISAR !== '1') {
    console.error('Si es lo que querés, corrélo de nuevo con DBZ_PISAR=1.')
    process.exit(1)
  }
}

const datos = normalizar(JSON.parse(fs.readFileSync(ruta, 'utf8')))
const cartas = reemplazar(base, fila.id, datos)
const sobrantes = Object.values(datos.cantidades).reduce((a, n) => a + (n - 1), 0)

console.log(`Listo: ${cartas} cartas para "${usuario}" (${sobrantes} repetidas).`)
base.close()
