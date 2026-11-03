export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isEmailAddress(value: string): boolean {
  if (value.length > 254 || /[\s<>]/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return local !== '' && /^[^.]+(\.[^.]+)+$/.test(domain)
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return `${email.slice(0, 1)}***${email.slice(at)}`
}
