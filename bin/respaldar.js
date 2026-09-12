#!/usr/bin/env node
// Copia la base a un archivo aparte, antes de cada deploy.
//
// No alcanza con `cp`: con WAL prendido, parte de lo último escrito todavía está en
// el archivo -wal y una copia cruda puede salir a medio camino. El backup de SQLite
// espera y deja un archivo consistente.
//
//   node bin/respaldar.js <base.db> <carpeta-destino> [cuántos guardar]
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const [origen, carpeta, cuantos = '14'] = process.argv.slice(2)
if (!origen || !carpeta) {
  console.error('uso: node bin/respaldar.js <base.db> <carpeta> [cuántos guardar]')
  process.exit(1)
}

fs.mkdirSync(carpeta, { recursive: true })
const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const destino = path.join(carpeta, `coleccion-${sello}.db`)

const base = new Database(origen, { readonly: true })
// Se cuenta desde el origen, que ya está abierto. Abrir la copia para contarla le
// dejaría un -wal y un -shm al lado que no hacen más que confundir.
const cartas = base.prepare('SELECT count(*) n FROM carta').get().n
await base.backup(destino)
base.close()
console.log(`respaldo en ${destino} (${cartas} cartas)`)

// Guardar para siempre no sirve: llenaría el disco sin que nadie lo mire.
const viejos = fs.readdirSync(carpeta)
  .filter((f) => f.startsWith('coleccion-') && f.endsWith('.db'))
  .sort().reverse().slice(Number(cuantos))
for (const f of viejos) fs.unlinkSync(path.join(carpeta, f))
if (viejos.length) console.log(`borré ${viejos.length} respaldos viejos`)
