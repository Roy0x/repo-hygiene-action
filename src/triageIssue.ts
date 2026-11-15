import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  Octokit,
  WELCOME_COMMENT_MARKER,
  createClient,
  getBooleanInput,
  getErrorStatus,
  getRepo,
  upsertMarkerComment,
} from './utils';

interface LabelRule {
  label: string;
  color: string;
  description: string;
  keywords: string[];
}

/** Keyword → label rules used by the issue triager. */
export const LABEL_RULES: LabelRule[] = [
  {
    label: 'bug',
    color: 'd73a4a',
    description: "Something isn't working",
    keywords: ['bug', 'error', 'crash', 'broken', 'exception'],
  },
  {
    label: 'enhancement',
    color: 'a2eeef',
    description: 'New feature or request',
    keywords: ['feature', 'enhancement', 'request', 'add'],
  },
  {
    label: 'documentation',
    color: '0075ca',
    description: 'Improvements or additions to documentation',
    keywords: ['docs', 'documentation', 'typo', 'readme'],
  },
];

const FIRST_TIME_ASSOCIATIONS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(text: string, keyword: string): boolean {
  // Word boundaries keep short keywords such as "add" from matching "address", while the
  // optional suffix still catches natural forms like "crashes", "errors" or "requested".
  return new RegExp(`\\b${escapeRegExp(keyword)}(?:s|es|ed|ing)?\\b`, 'i').test(text);
}

/** Return the labels whose keywords appear in the issue title or body. */
export function detectLabels(title: string, body: string): string[] {
  const text = `${title}\n${body}`;
  return LABEL_RULES.filter((rule) => rule.keywords.some((keyword) => matchesKeyword(text, keyword))).map(
    (rule) => rule.label,
  );
}

export function isFirstTimeContributor(authorAssociation: string | undefined): boolean {
  return authorAssociation !== undefined && FIRST_TIME_ASSOCIATIONS.has(authorAssociation.toUpperCase());
}

export async function ensureLabelsExist(
  octokit: Octokit,
  owner: string,
  repo: string,
  labels: string[],
): Promise<void> {
  const rules = LABEL_RULES.filter((rule) => labels.includes(rule.label));
  if (rules.length === 0) {
    return;
  }

  const existing = new Set<string>();
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  })) {
    for (const label of page.data) {
      existing.add(label.name.toLowerCase());
    }
  }

  for (const rule of rules) {
    if (existing.has(rule.label.toLowerCase())) {
      continue;
    }
    try {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: rule.label,
        color: rule.color,
        description: rule.description,
      });
      core.info(`Created missing label "${rule.label}".`);
    } catch (error) {
      // Another process may have created the label between listing and creating it.
      if (getErrorStatus(error) === 422) {
        core.info(`Label "${rule.label}" already exists.`);
        continue;
      }
      throw error;
    }
  }
}

function buildWelcomeComment(login: string, labels: string[]): string {
  const labelLine =
    labels.length > 0
      ? `We applied the following label${labels.length > 1 ? 's' : ''} to help it get triaged: ${labels
          .map((label) => `\`${label}\``)
          .join(', ')}.`
      : '';

  return [
    `👋 Welcome, @${login}!`,
    '',
    "Thanks for opening your first issue in this repository — we're glad you're here.",
    '',
    labelLine,
    labelLine ? '' : undefined,
    'A maintainer will take a look as soon as they can. To speed things up, please make sure your issue includes:',
    '',
    '- what you expected to happen',
    '- what actually happened',
    '- steps to reproduce the problem, if applicable',
    '',
    '<sub>Posted automatically by Repo Hygiene Action.</sub>',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

async function postWelcomeComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  login: string,
  labels: string[],
): Promise<void> {
  // The marker keeps this idempotent if the run is retried: an existing welcome is updated, not duplicated.
  const result = await upsertMarkerComment({
    octokit,
    owner,
    repo,
    issueNumber,
    marker: WELCOME_COMMENT_MARKER,
    body: buildWelcomeComment(login, labels),
  });
  core.info(`Welcome comment ${result}.`);
}

interface IssuePayload {
  number: number;
  title?: string | null;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  author_association?: string;
}

/** Entry point for `issues` events: apply keyword labels and welcome first-time contributors. */
export async function triageIssue(): Promise<void> {
  if (!getBooleanInput('enable-issue-triage', true)) {
    core.info('Issue triage is disabled ("enable-issue-triage" is false). Skipping.');
    return;
  }

  const issue = (github.context.payload as { issue?: IssuePayload }).issue;
  if (!issue) {
    core.warning('No issue payload found on this event. Skipping issue triage.');
    return;
  }

  const { owner, repo } = getRepo();
  const octokit = createClient();
  const title = issue.title ?? '';
  const body = issue.body ?? '';
  const labels = detectLabels(title, body);

  if (labels.length === 0) {
    core.info('No triage keywords matched the issue title or body.');
    core.setOutput('labels-applied', '');
  } else {
    await ensureLabelsExist(octokit, owner, repo, labels);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issue.number,
      labels,
    });
    core.info(`Applied label(s): ${labels.join(', ')}`);
    core.setOutput('labels-applied', labels.join(','));
  }

  const isOpened = github.context.payload.action === 'opened';
  if (!isOpened) {
    return;
  }

  if (!isFirstTimeContributor(issue.author_association)) {
    core.info('Author is not a first-time contributor; skipping welcome comment.');
    return;
  }

  if (issue.user?.type === 'Bot') {
    core.info('Issue author is a bot; skipping welcome comment.');
    return;
  }

  const login = issue.user?.login;
  if (!login) {
    core.warning('Unable to determine the issue author; skipping welcome comment.');
    return;
  }

  await postWelcomeComment(octokit, owner, repo, issue.number, login, labels);
}
