import type { MailError, MailMessage, Mailer } from '../src/mail.ts'

export type FakeMailer = Mailer & {
  sent: MailMessage[]
  failFor(to: string, error: MailError): void
  failAll(error: MailError | null): void
}

export function fakeMailer(): FakeMailer {
  const sent: MailMessage[] = []
  const failures = new Map<string, MailError>()
  let failingAll: MailError | null = null
  return {
    sent,
    failFor(to, error) {
      failures.set(to, error)
    },
    failAll(error) {
      failingAll = error
    },
    async send(message) {
      const error = failingAll ?? failures.get(message.to)
      if (error) throw error
      sent.push(message)
    },
  }
}
