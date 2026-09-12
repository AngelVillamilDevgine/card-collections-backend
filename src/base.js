// La base. Una sola tabla de cartas para todos: lo que separa una colección de otra
// es la columna usuario_id, que está en la clave primaria.
//
// Se guarda lo mismo que guardaba el archivo de antes — cuántas tenés y en qué
// condición — pero una fila por carta en vez de dos objetos enteros. Así un toque
// manda 30 bytes y no la colección completa.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export const RUTA = process.env.DBZ_BASE ?? path.resolve('datos/coleccion.db')

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS usuario (
  id       INTEGER PRIMARY KEY,
  usuario  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash     TEXT NOT NULL,
  creado   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesion (
  -- Se guarda el sha256 del token, no el token: si alguien se lleva la base,
  -- no se lleva sesiones vivas.
  hash       TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  creado     TEXT NOT NULL DEFAULT (datetime('now')),
  vence      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sesion_por_usuario ON sesion(usuario_id);

CREATE TABLE IF NOT EXISTS carta (
  usuario_id INTEGER NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  clave      TEXT NOT NULL,
  cantidad   INTEGER NOT NULL CHECK (cantidad > 0),
  estado     TEXT,
  PRIMARY KEY (usuario_id, clave)
) WITHOUT ROWID;
`

export function abrir(ruta = RUTA) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true })
  const base = new Database(ruta)
  // WAL: lecturas y escrituras no se bloquean entre sí. foreign_keys no viene
  // prendido por defecto en SQLite, y sin él los ON DELETE CASCADE no hacen nada.
  base.pragma('journal_mode = WAL')
  base.pragma('foreign_keys = ON')
  base.exec(ESQUEMA)
  return base
}

// Una carta con cantidad 0 no es una fila con un cero: es no tener fila. Igual que
// antes borrar la clave del objeto, y así el CHECK de arriba nunca se discute.
export function borrarVencidas(base) {
  return base.prepare("DELETE FROM sesion WHERE vence < datetime('now')").run().changes
}
