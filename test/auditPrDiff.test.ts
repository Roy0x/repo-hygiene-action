import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAuditComment, extractAddedLines, scanPatch } from '../src/auditPrDiff';

describe('extractAddedLines', () => {
  it('reports new-file line numbers from hunk headers', () => {
    const patch = [
      '@@ -1,4 +1,6 @@',
      ' line1',
      '+added2',
      ' line3',
      '+added4',
      '@@ -20,2 +22,3 @@ function handler() {',
      ' context',
      '+TODO: fix this',
    ].join('\n');

    assert.deepEqual(extractAddedLines(patch), [
      { line: 2, content: 'added2' },
      { line: 4, content: 'added4' },
      { line: 23, content: 'TODO: fix this' },
    ]);
  });

  it('does not treat file headers as added lines', () => {
    const patch = [
      'diff --git a/one.js b/one.js',
      '--- a/one.js',
      '+++ b/one.js',
      '@@ -1 +1 @@',
      '-old',
      '+first',
      'diff --git a/two.js b/two.js',
      '--- a/two.js',
      '+++ b/two.js',
      '@@ -1 +1 @@',
      '+second',
    ].join('\n');

    assert.deepEqual(extractAddedLines(patch), [
      { line: 1, content: 'first' },
      { line: 1, content: 'second' },
    ]);
  });

  it('ignores removed lines and missing-newline markers', () => {
    const patch = ['@@ -1,2 +1,1 @@', '-gone', '\\ No newline at end of file', '+kept'].join('\n');
    assert.deepEqual(extractAddedLines(patch), [{ line: 1, content: 'kept' }]);
  });
});

describe('scanPatch', () => {
  const patch = [
    '@@ -0,0 +1,5 @@',
    '+console.log(user);',
    '+  debugger;',
    '+const key = "sk-abcdefghijklmnopqrstuvwxyz123456";',
    '+const aws = "AKIA1234567890ABCDEF";',
    '+const ok = compute();',
  ].join('\n');

  it('flags every supported pattern on added lines', () => {
    const findings = scanPatch('src/app.ts', patch);
    assert.deepEqual(
      findings.map((finding) => finding.ruleId),
      ['console-log', 'debugger', 'secret', 'secret'],
    );
    assert.deepEqual(
      findings.map((finding) => finding.line),
      [1, 2, 3, 4],
    );
  });

  it('redacts credential values', () => {
    const secrets = scanPatch('src/app.ts', patch).filter((finding) => finding.ruleId === 'secret');
    for (const finding of secrets) {
      assert.ok(finding.snippet.includes('<redacted>'));
      assert.ok(!finding.snippet.includes('abcdefghijklmnopqrstuvwxyz'));
      assert.ok(!finding.snippet.includes('AKIA1234567890ABCDEF'));
    }
  });

  it('reports at most one finding per line', () => {
    const findings = scanPatch('src/app.ts', '@@ -0,0 +1 @@\n+console.log("TODO: later");');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'console-log');
  });

  it('is repeatable across calls', () => {
    assert.deepEqual(scanPatch('src/app.ts', patch), scanPatch('src/app.ts', patch));
  });

  it('finds nothing in clean patches', () => {
    assert.deepEqual(scanPatch('src/app.ts', '@@ -0,0 +1 @@\n+const total = sum(a, b);'), []);
  });
});

describe('buildAuditComment', () => {
  it('renders a clean pass', () => {
    const body = buildAuditComment({ findings: [], scannedFiles: 3, skippedFiles: 1 }, false);
    assert.match(body, /✅/);
    assert.match(body, /Scanned 3 changed file\(s\)/);
    assert.match(body, /1 file\(s\) had no text patch/);
  });

  it('renders a finding table with the fail-on-audit note', () => {
    const findings = scanPatch('src/app.ts', '@@ -0,0 +1 @@\n+console.log(user);');
    const body = buildAuditComment({ findings, scannedFiles: 1, skippedFiles: 0 }, true);
    assert.match(body, /\| File \| Line \| Finding \| Added line \|/);
    assert.match(body, /`src\/app\.ts`/);
    assert.match(body, /fail-on-audit: true/);
  });

  it('caps the table and reports the overflow', () => {
    const findings = Array.from({ length: 45 }, (_, index) => ({
      file: 'src/app.ts',
      line: index + 1,
      ruleId: 'todo',
      ruleLabel: 'Unfinished `TODO:` marker',
      snippet: '// TODO: later',
    }));
    const body = buildAuditComment({ findings, scannedFiles: 1, skippedFiles: 0 }, false);
    assert.match(body, /and 5 more finding\(s\) not shown/);
    assert.ok(!body.includes('| 45 |'));
  });
});
