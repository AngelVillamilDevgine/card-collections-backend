/* «Mi perfil»: los datos opcionales de cada cuenta.
 *
 * Lo pidió Angel el 2026-09-30 — con sólo un mail no hay forma de saber quién es quién ni
 * de contactar a nadie (el recupero de clave, por ejemplo, es un WhatsApp). NADA ES
 * OBLIGATORIO: un campo vacío se guarda como NULL, que quiere decir «no lo cargó».
 *
 * PUT reemplaza el perfil ENTERO: el front siempre manda los cinco campos, y un campo que
 * no viene queda vacío. Es más simple de razonar que un parche campo por campo, y el
 * formulario es uno solo.
 *
 * La validación vive acá y no en la ruta, igual que `revisarReemplazo`: así la prueban
 * los tests sin HTTP y nadie puede escribir la base salteándosela. */

/* La clave del front → la columna, el largo máximo (igual al de la columna) y cómo se
   nombra el campo en un mensaje de error. */
const FIELDS = {
  firstName: { column: 'first_name', max: 60, label: 'El nombre' },
  middleName: { column: 'middle_name', max: 60, label: 'El segundo nombre' },
  lastName: { column: 'last_name', max: 60, label: 'El apellido' },
  whatsapp: { column: 'whatsapp', max: 30, label: 'El WhatsApp' },
  city: { column: 'city', max: 80, label: 'La ciudad' },
}

/* Un WhatsApp es un número: dígitos, y puede llevar +, espacios, guiones y paréntesis
   porque así lo escribe la gente. Seis dígitos como mínimo, para que «123» no pase por un
   número. No se normaliza el formato: se guarda como lo escribió. */
const PHONE = /^\+?[\d\s()-]+$/

/* `{ data }` con las cinco columnas listas para el UPDATE, o `{ error }` con un mensaje
   para la persona. */
export function validateProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Faltan los datos del perfil.' }
  const data = {}
  for (const [key, { column, max, label }] of Object.entries(FIELDS)) {
    const raw = body[key]
    if (raw === undefined || raw === null) { data[column] = null; continue }
    if (typeof raw !== 'string') return { error: `${label} tiene que ser texto.` }
    // Espacios repetidos a uno solo: «Juan   Pablo» es «Juan Pablo».
    const value = raw.trim().replace(/\s+/g, ' ')
    if (/[\u0000-\u001f\u007f]/.test(value)) return { error: `${label} tiene caracteres que no van.` }
    if (value.length > max) return { error: `${label} puede tener hasta ${max} caracteres.` }
    /* Dos mensajes y no uno: «tiene que ser un número» sobre un «123» manda a mirar donde
       no está el problema — lo que falta es la característica. */
    if (key === 'whatsapp' && value) {
      if (!PHONE.test(value))
        return { error: 'El WhatsApp tiene que ser un número (puede llevar +, espacios, guiones y paréntesis).' }
      if (value.replace(/\D/g, '').length < 6)
        return { error: 'Ese WhatsApp parece incompleto: ponelo con la característica, por ejemplo 351 671-0050.' }
    }
    data[column] = value || null
  }
  return { data }
}

/* Lo que ve el front: las claves en camelCase y un campo vacío como '' — el formulario
   trabaja con strings y así no tiene que convertir nada. */
export function toProfile(row) {
  const out = {}
  for (const [key, { column }] of Object.entries(FIELDS)) out[key] = row?.[column] ?? ''
  return out
}

export async function readProfile(pool, userId) {
  const [rows] = await pool.query(
    'SELECT usuario, first_name, middle_name, last_name, whatsapp, city FROM usuario WHERE id = ?',
    [userId]
  )
  return rows.length ? { usuario: rows[0].usuario, ...toProfile(rows[0]) } : null
}

/* Las columnas vienen de FIELDS, nunca del cliente: lo único que se interpola en el SQL
   son esos cinco nombres fijos; los valores van bindeados. */
export async function saveProfile(pool, userId, data) {
  const columns = Object.values(FIELDS).map((f) => f.column)
  await pool.query(
    `UPDATE usuario SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => data[c] ?? null), userId]
  )
}
