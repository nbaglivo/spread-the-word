import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyMailError, MailError } from './mail.ts'

test('rejected recipient with a 5xx reply is permanent', () => {
  const error = classifyMailError({ responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO', response: '550 no such user' })
  assert.ok(error instanceof MailError)
  assert.equal(error.permanent, true)
  assert.match(error.message, /550 no such user/)
})

test('rejected recipient without an envelope code is permanent', () => {
  assert.equal(classifyMailError({ responseCode: 550, command: 'RCPT TO', response: '550 no such user' }).permanent, true)
})

test('authentication failures are temporary', () => {
  assert.equal(classifyMailError({ responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN' }).permanent, false)
})

test('sender rejections are temporary even though nodemailer tags them EENVELOPE', () => {
  assert.equal(classifyMailError({ responseCode: 554, command: 'MAIL FROM' }).permanent, false)
  assert.equal(classifyMailError({ responseCode: 554, code: 'EENVELOPE', command: 'MAIL FROM', response: '554 rejected' }).permanent, false)
})

test('4xx recipient replies are temporary', () => {
  assert.equal(classifyMailError({ responseCode: 451, command: 'RCPT TO' }).permanent, false)
})

test('connection problems and unknown errors are temporary', () => {
  assert.equal(classifyMailError({ code: 'ECONNECTION' }).permanent, false)
  assert.equal(classifyMailError({ code: 'ETIMEDOUT' }).permanent, false)
  assert.equal(classifyMailError(new Error('boom')).permanent, false)
  assert.equal(classifyMailError('string').permanent, false)
})

test('keeps the message of a plain error', () => {
  assert.equal(classifyMailError(new Error('boom')).message, 'boom')
})

test('returns an existing MailError unchanged', () => {
  const error = new MailError('already', true)
  assert.equal(classifyMailError(error), error)
})
