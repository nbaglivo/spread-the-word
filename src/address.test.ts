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

test('isEmailAddress rejects separators nodemailer would parse as lists, groups or comments', () => {
  for (const bad of ['a,b@x.com', 'list:victim@x.com', 'victim(c)@x.com', 'a;b@x.com', '"a"@x.com', '.a@x.com', 'a.@x.com', 'a..b@x.com']) {
    assert.equal(isEmailAddress(bad), false, bad)
  }
})

test('isEmailAddress allows exactly 254 characters', () => {
  const domain = `${'d'.repeat(61)}.${'d'.repeat(61)}.${'d'.repeat(61)}.com`
  const at = (total: number) => `${'a'.repeat(total - domain.length - 1)}@${domain}`
  assert.equal(at(254).length, 254)
  assert.equal(isEmailAddress(at(254)), true)
  assert.equal(isEmailAddress(at(255)), false)
})

test('maskEmail hides all but the first character of the local part', () => {
  assert.equal(maskEmail('nico@gmail.com'), 'n***@gmail.com')
  assert.equal(maskEmail('n@x.dev'), 'n***@x.dev')
})
