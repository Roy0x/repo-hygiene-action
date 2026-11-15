import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLabels, isFirstTimeContributor } from '../src/triageIssue';

describe('detectLabels', () => {
  it('labels bug keywords', () => {
    assert.deepEqual(detectLabels('App crashes on start', ''), ['bug']);
  });

  it('matches keywords case-insensitively', () => {
    assert.deepEqual(detectLabels('EXCEPTION thrown in parser', ''), ['bug']);
  });

  it('matches plural and past-tense forms', () => {
    assert.deepEqual(detectLabels('Errors when saving files', ''), ['bug']);
    assert.deepEqual(detectLabels('Requested feature: export to CSV', ''), ['enhancement']);
  });

  it('detects documentation keywords', () => {
    assert.deepEqual(detectLabels('Update docs', 'Fix a typo in the readme'), ['documentation']);
  });

  it('does not match keywords inside other words', () => {
    assert.deepEqual(detectLabels('Address book support', ''), []);
    assert.deepEqual(detectLabels('Debug the address parsing', ''), []);
  });

  it('can apply several labels to one issue', () => {
    assert.deepEqual(detectLabels('Bug: add readme docs', ''), [
      'bug',
      'enhancement',
      'documentation',
    ]);
  });
});

describe('isFirstTimeContributor', () => {
  it('accepts first-time and unaffiliated authors', () => {
    assert.equal(isFirstTimeContributor('FIRST_TIME_CONTRIBUTOR'), true);
    assert.equal(isFirstTimeContributor('FIRST_TIMER'), true);
    assert.equal(isFirstTimeContributor('none'), true);
  });

  it('rejects returning contributors and missing associations', () => {
    assert.equal(isFirstTimeContributor('CONTRIBUTOR'), false);
    assert.equal(isFirstTimeContributor('MEMBER'), false);
    assert.equal(isFirstTimeContributor(undefined), false);
  });
});
