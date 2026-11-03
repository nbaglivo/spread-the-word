import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEmail, isEmailAddress, maskEmail } from './address.ts'

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail(' Nico@Example.COM '), 'nico@example.com')
})

test('isEmailAddress accepts plain addresses', () => {
  assert.equal(isEmailAddress('a@b.co'), true)
})

test('isEmailAddress rejects malformed addresses', () => {
  for (const bad of ['', 'a', 'a@b', 'a@@b.co', 'a b@c.co', '<a@b.co>', `${'a'.repeat(250)}@b.co`]) {
    assert.equal(isEmailAddress(bad), false, bad)
  }
})

test('maskEmail hides all but the first character of the local part', () => {
  assert.equal(maskEmail('nico@gmail.com'), 'n***@gmail.com')
  assert.equal(maskEmail('n@x.dev'), 'n***@x.dev')
})
