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

import { parsePhoneNumberFromString, validatePhoneNumberLength } from 'libphonenumber-js/min'

/* La clave del front → la columna, el largo máximo y cómo se nombra el campo en un
   mensaje de error. El máximo es el de la columna salvo en el WhatsApp, donde es el del
   texto tal como llega («+54 9 351 671-0050»): lo que se guarda son a lo sumo 15 dígitos. */
const FIELDS = {
  firstName: { column: 'first_name', max: 60, label: 'El nombre' },
  middleName: { column: 'middle_name', max: 60, label: 'El segundo nombre' },
  lastName: { column: 'last_name', max: 60, label: 'El apellido' },
  whatsapp: { column: 'whatsapp', max: 30, label: 'El WhatsApp' },
  city: { column: 'city', max: 80, label: 'La ciudad' },
}

/* EL WHATSAPP SE GUARDA EN E.164 SIN EL «+», SÓLO DÍGITOS: 5493516710050. Lo pidió Angel
   el 2026-09-30 —«todo el número junto en la base, sólo números»—, y es además la forma
   que pide wa.me. Cómo se VE (bandera, característica, guion) es cosa del front.

   Entra de dos formas y las dos se aceptan: con «+» es internacional, que es lo que manda
   el front desde ese día; sin «+» se lee como lo tipea alguien de acá —«0351 15 671-0050»,
   «11 5555-1234»—, que es lo que mandaba el front de antes y lo que quedó guardado. La
   librería es la misma del front y en la misma versión: si se separan, un número que el
   front da por bueno lo rechaza el servidor.

   Se valida por LARGO (metadata `min`) y no contra los rangos asignados de cada país
   (`max`): los rangos rechazan números reales cuando la metadata atrasa, y quien escribe
   su propio número no tiene cómo discutirle a la librería.

   EL 9 DE LOS CELULARES ARGENTINOS. WhatsApp necesita +54 9 + característica + número, y
   la librería sólo lo pone si la persona tipeó el 0 y el 15. Acá todo número argentino es
   un celular —es un WhatsApp—, así que el 9 se agrega siempre.

   ESTAS TRES FUNCIONES ESTÁN COPIADAS EN `frontend/src/phone.js`, con los mismos nombres:
   no hay forma de importar de un repo al otro. Si se toca una, se toca la otra, y los
   casos de `test/profile.test.js` y del `phone.test.js` del front tienen que seguir
   siendo los mismos. */
const LETTERS = /[^\d\s()+.-]/
const ONLY_DIGITS = 'El WhatsApp va sólo con números.'
const INCOMPLETE = 'Ese WhatsApp parece incompleto: ponelo con la característica, por ejemplo 351 671-0050.'
const NOT_A_PHONE = 'Ese WhatsApp no parece un número de teléfono: revisá la característica y el número.'

const lengthError = (number, country) =>
  validatePhoneNumberLength(number, country) === 'TOO_SHORT' ? INCOMPLETE : NOT_A_PHONE

/* Un número argentino, como lo diga cada uno —con 0, con 15, con el 9 adelante—, llevado
   a característica + número: diez dígitos que empiezan con 11, 2 o 3. Lo que no, es un
   0800, un 0810 o un error de tipeo («9 15 5555 1234»), y que tenga el largo justo no lo
   vuelve un celular. */
function argentineBase(national) {
  const typed = national.startsWith('9') ? national.slice(1) : national
  const phone = parsePhoneNumberFromString(typed, 'AR')
  if (!phone?.isValid()) return { error: lengthError(typed, 'AR') }
  const base = phone.nationalNumber.replace(/^9/, '') // el 9 que pone la librería al sacar el 15
  if (base.length !== 10 || !/^(11|[23])/.test(base)) return { error: NOT_A_PHONE }
  return { digits: '549' + base }
}

/* Un número con su código de país, sin el «+». Tiene que ser de un país de verdad —un +800
   no tiene WhatsApp— y caber en un E.164, que son 15 dígitos: la metadata `min` deja pasar
   algunos alemanes de 16. El «1» de los celulares mexicanos (+52 1 55…, la forma que
   todavía usa WhatsApp) se saca, igual que el 9 argentino se pone. */
function international(digits) {
  if (digits.startsWith('54')) return argentineBase(digits.slice(2))
  if (digits.startsWith('521') && digits.length === 13) digits = '52' + digits.slice(3)
  const phone = parsePhoneNumberFromString('+' + digits)
  if (!phone?.isValid() || !phone.country) return { error: lengthError('+' + digits) }
  const e164 = phone.countryCallingCode + phone.nationalNumber
  return e164.length > 15 ? { error: NOT_A_PHONE } : { digits: e164 }
}

/* Lo que llega, en cualquiera de las formas: con «+» o con 00 es internacional; sin «+»
   pero empezando con 54 es el código sin el «+» (5493516710050) —ninguna característica
   argentina empieza con 5—; el resto es un número de acá. Un número sin «+» NUNCA se lee
   como de otro país: un «299 824842» al que le falta un dígito era Groenlandia. */
export function normalizeWhatsapp(raw) {
  const text = String(raw ?? '').trim()
  if (LETTERS.test(text)) return { error: ONLY_DIGITS }
  const digits = text.replace(/\D/g, '')
  if (text.startsWith('+')) return international(digits)
  if (digits.startsWith('00')) return international(digits.slice(2))
  if (digits.startsWith('54')) return international(digits)
  return argentineBase(digits)
}

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
    if (key === 'whatsapp' && value) {
      const { digits, error } = normalizeWhatsapp(value)
      if (error) return { error }
      data[column] = digits
      continue
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
