/**
 * A plain copy: strips Vue reactive proxies and anything non-JSON.
 * JSON, because structuredClone and IndexedDB reject reactive proxies.
 */
export function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
