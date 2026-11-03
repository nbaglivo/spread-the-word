import nodemailer from 'nodemailer'
import type { SmtpConfig } from './config.ts'

export type MailMessage = {
  from: string
  to: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export class MailError extends Error {
  name = 'MailError'
  permanent: boolean

  constructor(message: string, permanent: boolean) {
    super(message)
    this.permanent = permanent
  }
}

type SmtpErrorShape = { responseCode?: unknown; command?: unknown; response?: unknown; message?: unknown }

export function classifyMailError(error: unknown): MailError {
  if (error instanceof MailError) return error
  if (typeof error !== 'object' || error === null) return new MailError(String(error), false)
  const { responseCode, command, response, message } = error as SmtpErrorShape
  const text = typeof response === 'string' ? response : typeof message === 'string' ? message : String(error)
  const permanent = typeof responseCode === 'number' && responseCode >= 500 && responseCode <= 599 && command === 'RCPT TO'
  return new MailError(text, permanent)
}

export function smtpMailer(smtp: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.password },
  })
  return {
    async send(message) {
      try {
        await transport.sendMail(message)
      } catch (error) {
        throw classifyMailError(error)
      }
    },
  }
}
