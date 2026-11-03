export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/

export function isEmailAddress(value: string): boolean {
  if (value.length > 254) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  return HOSTNAME.test(domain.toLowerCase())
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return `${email.slice(0, 1)}***${email.slice(at)}`
}
