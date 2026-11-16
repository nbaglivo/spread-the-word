import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getLogger, withContext, type LogRecord } from '@logtape/logtape'
import { formatLine } from './logging.ts'
import { captureLogs } from '../test/logs.ts'

function record(properties: Record<string, unknown>): LogRecord {
  return {
    category: ['fedify', 'federation', 'outbox'],
    level: 'info',
    message: ['Successfully sent activity ', 'https://ap.test/a#create', ' to ', 'https://remote.test/inbox', '.'],
    rawMessage: 'Successfully sent activity {activityId} to {inbox}.',
    timestamp: Date.parse('2026-10-16T12:43:49.208Z'),
    properties,
  }
}

test('log lines leave out the full activity body', () => {
  const line = JSON.parse(formatLine(record({ activityId: 'https://ap.test/a#create', inbox: 'https://remote.test/inbox', activity: { type: 'Create', content: 'x'.repeat(5000) } })))
  assert.equal(line.message, 'Successfully sent activity "https://ap.test/a#create" to "https://remote.test/inbox".')
  assert.equal(line.properties.inbox, 'https://remote.test/inbox')
  assert.equal('activity' in line.properties, false)
})

test('logging inside a context does not warn about context-local storage', async () => {
  const logs = await captureLogs()
  withContext({ requestId: '1' }, () => getLogger(['stw']).info('hello'))
  assert.deepEqual(logs.lines('logtape.meta'), [])
  assert.deepEqual(logs.lines('stw'), ['hello'])
})
