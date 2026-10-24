// A small params schema. It validates, applies defaults and bounds every field (params come from
// strangers' URLs), coerces query-string values, and implements Standard Schema
// (https://standardschema.dev), so a scenario can use zod, valibot or arktype instead.

export class ParamError extends Error {
  constructor(message, path = []) {
    super(path.length ? `${path.join('.')}: ${message}` : message)
    this.reason = message
    this.path = path
  }
}

const standard = (schema) => {
  schema['~standard'] = {
    version: 1,
    vendor: 'streaming-og-video',
    validate(value) {
      try {
        return { value: schema.parse(value) }
      } catch (e) {
        if (!(e instanceof ParamError)) throw e
        return { issues: [{ message: e.reason, path: e.path }] }
      }
    },
  }
  return schema
}

// An empty string is a value for strings (so a URL can clear a field with ?kicker=), and
// missing for every other kind.
const missing = (v, kind) => v === undefined || v === null || (v === '' && kind !== 'string')

function base(kind, opts, check) {
  return standard({
    kind,
    opts,
    /** Fields that can be given directly in a query string. */
    scalar: kind !== 'array' && kind !== 'object',
    parse(v, path = []) {
      if (missing(v, kind)) {
        if (opts.default !== undefined) return typeof opts.default === 'function' ? opts.default() : opts.default
        if (opts.optional) return undefined
        throw new ParamError('required', path)
      }
      return check(v, path)
    },
  })
}

export const p = {
  /** A string, trimmed, at most `max` characters (default 200). */
  string(opts = {}) {
    const { max = 200, min = 0, pattern } = opts
    return base('string', opts, (v, path) => {
      if (typeof v !== 'string' && typeof v !== 'number') throw new ParamError('expected a string', path)
      const s = String(v).trim()
      const n = [...s].length
      if (n > max) throw new ParamError(`at most ${max} characters`, path)
      if (n < min) throw new ParamError(`at least ${min} characters`, path)
      if (pattern && !pattern.test(s)) throw new ParamError(`does not match ${pattern}`, path)
      return s
    })
  },
  /** An integer in [min, max]; query strings are parsed. */
  int(opts = {}) {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts
    return base('int', opts, (v, path) => {
      const n = typeof v === 'string' ? Number(v) : v
      if (!Number.isInteger(n)) throw new ParamError('expected an integer', path)
      if (n < min || n > max) throw new ParamError(`expected ${min} to ${max}`, path)
      return n
    })
  },
  /** A finite number in [min, max]. */
  number(opts = {}) {
    const { min = -Infinity, max = Infinity } = opts
    return base('number', opts, (v, path) => {
      const n = typeof v === 'string' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new ParamError('expected a number', path)
      if (n < min || n > max) throw new ParamError(`expected ${min} to ${max}`, path)
      return n
    })
  },
  /** true/false; query strings accept 1/0, true/false, yes/no. */
  bool(opts = {}) {
    return base('bool', opts, (v, path) => {
      if (typeof v === 'boolean') return v
      if (/^(1|true|yes|on)$/i.test(String(v))) return true
      if (/^(0|false|no|off)$/i.test(String(v))) return false
      throw new ParamError('expected true or false', path)
    })
  },
  /** One of `values`. */
  enum(values, opts = {}) {
    const schema = base('enum', opts, (v, path) => {
      if (!values.includes(v)) throw new ParamError(`expected one of ${values.join(', ')}`, path)
      return v
    })
    schema.values = values
    return schema
  },
  /** A colour as '#rrggbb' (accepts rgb, rrggbb, with or without '#'), normalized to lower case. */
  color(opts = {}) {
    return base('color', opts, (v, path) => {
      const m = String(v).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
      if (!m) throw new ParamError('expected a hex colour like #3b82f6', path)
      const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
      return `#${h.toLowerCase()}`
    })
  },
  /** An array of `item`, at most `max` long (default 20). */
  array(item, opts = {}) {
    const { max = 20, min = 0 } = opts
    const schema = base('array', opts, (v, path) => {
      if (typeof v === 'string') v = parseJson(v, path)
      if (!Array.isArray(v)) throw new ParamError('expected an array', path)
      if (v.length > max) throw new ParamError(`at most ${max} items`, path)
      if (v.length < min) throw new ParamError(`at least ${min} items`, path)
      return v.map((x, i) => item.parse(x, [...path, i]))
    })
    schema.item = item
    return schema
  },
  /** An object with exactly these fields; unknown fields are dropped. */
  object(shape, opts = {}) {
    const schema = base('object', opts, (v, path) => {
      if (typeof v === 'string') v = parseJson(v, path)
      if (typeof v !== 'object' || Array.isArray(v)) throw new ParamError('expected an object', path)
      const out = {}
      for (const [k, s] of Object.entries(shape)) {
        const value = s.parse(v[k], [...path, k])
        if (value !== undefined) out[k] = value
      }
      return out
    })
    schema.shape = shape
    return schema
  },
}

function parseJson(s, path) {
  try {
    return JSON.parse(s)
  } catch {
    throw new ParamError('expected JSON', path)
  }
}

/**
 * Validates `value` with a scenario's schema: ours (sync) or any Standard Schema (maybe async).
 * @returns {Promise<any>}
 */
export async function validate(schema, value) {
  const result = await schema['~standard'].validate(value)
  if (result.issues) {
    const issue = result.issues[0]
    const path = (issue.path ?? []).map((s) => (typeof s === 'object' ? s.key : s))
    throw new ParamError(issue.message, path)
  }
  return result.value
}

/**
 * A JSON description of one of our schemas, for building forms and docs: kind, default,
 * optional, bounds, enum values, and nested item/shape descriptions.
 */
export function describe(schema) {
  const { kind, opts = {} } = schema
  const out = { kind }
  const def = typeof opts.default === 'function' ? opts.default() : opts.default
  if (def !== undefined) out.default = def
  if (opts.optional) out.optional = true
  for (const k of ['min', 'max']) if (opts[k] !== undefined && Number.isFinite(opts[k])) out[k] = opts[k]
  if (opts.pattern) out.pattern = String(opts.pattern)
  if (kind === 'enum') out.values = schema.values
  if (kind === 'array') out.item = describe(schema.item)
  if (kind === 'object') out.shape = Object.fromEntries(Object.entries(schema.shape).map(([k, s]) => [k, describe(s)]))
  return out
}
