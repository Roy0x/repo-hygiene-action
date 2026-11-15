import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PR_TYPES, validatePrTitle } from '../src/checkPrTitle';

describe('validatePrTitle', () => {
  it('parses type, scope and description', () => {
    const result = validatePrTitle('feat(api): add pagination', DEFAULT_PR_TYPES);
    assert.ok(result.ok);
    assert.equal(result.type, 'feat');
    assert.equal(result.scope, 'api');
    assert.equal(result.breaking, false);
    assert.equal(result.description, 'add pagination');
  });

  it('accepts titles without a scope', () => {
    const result = validatePrTitle('fix: handle empty body', DEFAULT_PR_TYPES);
    assert.ok(result.ok);
    assert.equal(result.scope, undefined);
  });

  it('accepts a breaking change marker', () => {
    const result = validatePrTitle('feat(api)!: drop v1 endpoints', DEFAULT_PR_TYPES);
    assert.ok(result.ok);
    assert.equal(result.breaking, true);
  });

  it('normalizes the type to lower case', () => {
    const result = validatePrTitle('FEAT: shout', DEFAULT_PR_TYPES);
    assert.ok(result.ok);
    assert.equal(result.type, 'feat');
  });

  it('rejects titles that do not match the pattern', () => {
    for (const title of ['Add stuff', 'feat add stuff', 'feat(): stuff', 'feat:   ']) {
      const result = validatePrTitle(title, DEFAULT_PR_TYPES);
      assert.ok(!result.ok, `expected "${title}" to be rejected`);
      assert.match(result.reason, /pattern/);
    }
  });

  it('rejects unknown types and types outside allowed-pr-types', () => {
    const unknown = validatePrTitle('foo: add stuff', DEFAULT_PR_TYPES);
    assert.ok(!unknown.ok);
    assert.match(unknown.reason, /not one of the allowed types/);

    const disallowed = validatePrTitle('docs: tweak wording', ['feat', 'fix']);
    assert.ok(!disallowed.ok);
    assert.match(disallowed.reason, /not one of the allowed types/);
  });

  it('rejects an empty title', () => {
    const result = validatePrTitle('   ', DEFAULT_PR_TYPES);
    assert.ok(!result.ok);
    assert.match(result.reason, /empty/);
  });

  it('ships the documented default types', () => {
    assert.deepEqual(DEFAULT_PR_TYPES, [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]);
  });
});
