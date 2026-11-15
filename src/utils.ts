import * as core from '@actions/core';
import * as github from '@actions/github';

/** Octokit client type returned by `@actions/github`, including `paginate`. */
export type Octokit = ReturnType<typeof github.getOctokit>;

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

const TRUE_VALUES = new Set(['true', 'yes', '1', 'on']);
const FALSE_VALUES = new Set(['false', 'no', '0', 'off']);

/** Parse a boolean-style action input, falling back to `defaultValue` when unset or unparseable. */
export function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (TRUE_VALUES.has(raw)) {
    return true;
  }
  if (FALSE_VALUES.has(raw)) {
    return false;
  }
  core.warning(`Input "${name}" has an unexpected value "${raw}". Using the default (${defaultValue}).`);
  return defaultValue;
}

/** Parse a comma-separated action input into a de-duplicated, lower-cased list. */
export function getListInput(name: string, defaultValue: string[]): string[] {
  const raw = core.getInput(name).trim();
  if (!raw) {
    return [...defaultValue];
  }
  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return values.length > 0 ? [...new Set(values)] : [...defaultValue];
}

/** Build an Octokit client from the required `github-token` input. */
export function createClient(): Octokit {
  const token = core.getInput('github-token', { required: true });
  if (!token) {
    throw new Error('The "github-token" input is required but was empty.');
  }
  return github.getOctokit(token);
}

export function getRepo(): RepoCoordinates {
  const { owner, repo } = github.context.repo;
  return { owner, repo };
}

/** Truncate text safely for GitHub comment bodies (hard limit is 65536 characters). */
export function truncate(text: string, maxLength = 60000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 20)}\n…(truncated)`;
}

export const AUDIT_COMMENT_MARKER = '<!-- repo-hygiene-action:pr-audit -->';
export const WELCOME_COMMENT_MARKER = '<!-- repo-hygiene-action:welcome -->';

interface IssueCommentLike {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}

let cachedLogin: string | null | undefined;

async function getAuthenticatedLogin(octokit: Octokit): Promise<string | undefined> {
  if (cachedLogin !== undefined) {
    return cachedLogin ?? undefined;
  }
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    cachedLogin = data.login;
  } catch {
    cachedLogin = null;
  }
  return cachedLogin ?? undefined;
}

/**
 * Find an existing comment containing `marker` that was written by a bot or by this token's user.
 * This keeps re-runs idempotent instead of piling up duplicate comments.
 */
async function findMarkerComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
): Promise<IssueCommentLike | undefined> {
  const matches: IssueCommentLike[] = [];
  for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  })) {
    for (const comment of page.data as IssueCommentLike[]) {
      if ((comment.body ?? '').includes(marker)) {
        matches.push(comment);
      }
    }
  }

  if (matches.length === 0) {
    return undefined;
  }

  const botComment = matches.find(
    (comment) => comment.user?.type === 'Bot' || (comment.user?.login ?? '').endsWith('[bot]'),
  );
  if (botComment) {
    return botComment;
  }

  const login = await getAuthenticatedLogin(octokit);
  if (!login) {
    return undefined;
  }
  return matches.find((comment) => comment.user?.login === login);
}

/** Create or update the single marker-tagged comment on an issue or pull request. */
export async function upsertMarkerComment(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  issueNumber: number;
  marker: string;
  body: string;
}): Promise<'created' | 'updated'> {
  const { octokit, owner, repo, issueNumber, marker, body } = params;
  const existing = await findMarkerComment(octokit, owner, repo, issueNumber, marker);
  const payload = truncate(`${marker}\n${body}`);

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: payload });
    return 'updated';
  }

  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: payload });
  return 'created';
}

/** Turn an unknown thrown value into a readable message. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Extract the HTTP status from an Octokit error, when present. */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
