import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postSummaryComment } from '../src/auditPrDiff';
import { ensureLabelsExist } from '../src/triageIssue';
import { AUDIT_COMMENT_MARKER, upsertMarkerComment, type Octokit } from '../src/utils';
import { FakeOctokit } from './fakeOctokit';

function asOctokit(fake: FakeOctokit): Octokit {
  return fake as unknown as Octokit;
}

function upsertParams(fake: FakeOctokit, body = 'summary'): Parameters<typeof upsertMarkerComment>[0] {
  return {
    octokit: asOctokit(fake),
    owner: 'octo',
    repo: 'repo',
    issueNumber: 1,
    marker: AUDIT_COMMENT_MARKER,
    body,
  };
}

describe('ensureLabelsExist', () => {
  it('creates a missing label with its default color and description', async () => {
    const fake = new FakeOctokit();
    await ensureLabelsExist(asOctokit(fake), 'octo', 'repo', ['bug']);

    assert.deepEqual(fake.createdLabels, [
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
    ]);
  });

  it('leaves existing labels alone, matching case-insensitively', async () => {
    const fake = new FakeOctokit({
      labels: [{ name: 'Bug', color: 'd73a4a', description: 'already here' }],
    });
    await ensureLabelsExist(asOctokit(fake), 'octo', 'repo', ['bug']);

    assert.equal(fake.createLabelAttempts, 0);
  });

  it('creates only the labels that are missing', async () => {
    const fake = new FakeOctokit({
      labels: [{ name: 'bug', color: 'd73a4a', description: 'already here' }],
    });
    await ensureLabelsExist(asOctokit(fake), 'octo', 'repo', ['bug', 'documentation']);

    assert.deepEqual(
      fake.createdLabels.map((label) => label.name),
      ['documentation'],
    );
  });

  it('tolerates a concurrent creation (422)', async () => {
    const fake = new FakeOctokit({ createLabelError: 422 });
    await assert.doesNotReject(ensureLabelsExist(asOctokit(fake), 'octo', 'repo', ['bug']));

    assert.equal(fake.createLabelAttempts, 1);
    assert.equal(fake.createdLabels.length, 0);
  });

  it('propagates other label errors', async () => {
    const fake = new FakeOctokit({ createLabelError: 403 });
    await assert.rejects(ensureLabelsExist(asOctokit(fake), 'octo', 'repo', ['bug']), /Forbidden/);
  });
});

describe('upsertMarkerComment', () => {
  it('creates one marker-tagged comment when none exists', async () => {
    const fake = new FakeOctokit();
    const result = await upsertMarkerComment(upsertParams(fake));

    assert.equal(result, 'created');
    assert.equal(fake.createdComments.length, 1);
    assert.ok(fake.createdComments[0].startsWith(AUDIT_COMMENT_MARKER));
    assert.equal(fake.updatedComments.length, 0);
  });

  it('updates an existing bot comment instead of posting another', async () => {
    const fake = new FakeOctokit({
      comments: [
        {
          id: 42,
          body: `${AUDIT_COMMENT_MARKER}\nstale summary`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ],
    });
    const result = await upsertMarkerComment(upsertParams(fake, 'fresh summary'));

    assert.equal(result, 'updated');
    assert.equal(fake.createdComments.length, 0);
    assert.deepEqual(fake.updatedComments.map((comment) => comment.id), [42]);
    assert.ok(fake.updatedComments[0].body.includes('fresh summary'));
    assert.equal(fake.comments.length, 1);
  });

  it('stays idempotent across re-runs', async () => {
    const fake = new FakeOctokit();
    await upsertMarkerComment(upsertParams(fake, 'first'));
    await upsertMarkerComment(upsertParams(fake, 'second'));

    assert.equal(fake.createdComments.length, 1);
    assert.equal(fake.updatedComments.length, 1);
    assert.equal(fake.comments.length, 1);
  });

  it('prefers a bot comment when several carry the marker', async () => {
    const fake = new FakeOctokit({
      comments: [
        { id: 1, body: AUDIT_COMMENT_MARKER, user: { login: 'someone', type: 'User' } },
        { id: 2, body: AUDIT_COMMENT_MARKER, user: { login: 'ci[bot]', type: 'Bot' } },
      ],
    });
    await upsertMarkerComment(upsertParams(fake));

    assert.deepEqual(fake.updatedComments.map((comment) => comment.id), [2]);
  });

  it('updates a marker comment authored by the token user', async () => {
    const fake = new FakeOctokit({
      selfLogin: 'hygiene-bot',
      comments: [
        { id: 7, body: AUDIT_COMMENT_MARKER, user: { login: 'hygiene-bot', type: 'User' } },
      ],
    });
    const result = await upsertMarkerComment(upsertParams(fake));

    assert.equal(result, 'updated');
    assert.deepEqual(fake.updatedComments.map((comment) => comment.id), [7]);
  });

  it('ignores marker comments from unrelated users', async () => {
    const fake = new FakeOctokit({
      selfLogin: 'hygiene-bot',
      comments: [
        { id: 3, body: AUDIT_COMMENT_MARKER, user: { login: 'stranger', type: 'User' } },
      ],
    });
    const result = await upsertMarkerComment(upsertParams(fake));

    assert.equal(result, 'created');
    assert.equal(fake.comments.length, 2);
  });
});

describe('postSummaryComment', () => {
  it('posts the summary through the marker upsert', async () => {
    const fake = new FakeOctokit();
    await postSummaryComment(asOctokit(fake), 'octo', 'repo', 5, '## summary');

    assert.equal(fake.createdComments.length, 1);
    assert.ok(fake.createdComments[0].startsWith(AUDIT_COMMENT_MARKER));
    assert.ok(fake.createdComments[0].includes('## summary'));
  });

  it('warns instead of throwing when the token is read-only (fork PR)', async () => {
    const fake = new FakeOctokit({ createCommentError: 403 });
    const captured: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;

    try {
      await assert.doesNotReject(postSummaryComment(asOctokit(fake), 'octo', 'repo', 5, '## summary'));
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = captured.join('');
    assert.match(output, /::warning::/);
    assert.match(output, /Resource not accessible by integration/);
    assert.equal(fake.comments.length, 0);
  });
});
