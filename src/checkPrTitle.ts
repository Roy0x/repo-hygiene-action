import * as core from '@actions/core';
import * as github from '@actions/github';
import { getBooleanInput, getListInput } from './utils';

export const DEFAULT_PR_TYPES = [
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
];

const TITLE_PATTERN =
  /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?: (?<description>\S(?:.*\S)?)$/;

export type TitleValidation =
  | { ok: true; type: string; scope?: string; breaking: boolean; description: string }
  | { ok: false; reason: string };

/** Validate a PR title against `<type>(optional-scope): <description>`. */
export function validatePrTitle(title: string, allowedTypes: string[]): TitleValidation {
  const trimmed = title.trim();
  if (!trimmed) {
    return { ok: false, reason: 'The pull request title is empty.' };
  }

  const match = TITLE_PATTERN.exec(trimmed);
  if (!match?.groups) {
    return {
      ok: false,
      reason: 'The title does not match the `<type>(optional-scope): <description>` pattern.',
    };
  }

  const groups = match.groups as {
    type: string;
    scope?: string;
    breaking?: string;
    description: string;
  };
  const type = groups.type.toLowerCase();

  if (!allowedTypes.includes(type)) {
    return {
      ok: false,
      reason: `"${groups.type}" is not one of the allowed types.`,
    };
  }

  return {
    ok: true,
    type,
    scope: groups.scope?.trim(),
    breaking: Boolean(groups.breaking),
    // The pattern already guarantees a non-empty, trimmed description.
    description: groups.description.trim(),
  };
}

function buildFailureMessage(title: string, reason: string, allowedTypes: string[]): string {
  const primary = allowedTypes[0] ?? 'feat';
  const secondary = allowedTypes[1] ?? 'fix';
  const tertiary = allowedTypes[2] ?? 'docs';
  const quoted = title.trim() ? `"${title.trim()}"` : '(empty title)';

  return [
    `Invalid pull request title: ${quoted}`,
    '',
    reason,
    '',
    'Titles must follow the Conventional Commits format:',
    '',
    '  <type>(optional-scope): <description>',
    '',
    'Examples of valid titles:',
    '',
    `  ${primary}(api): add pagination to list endpoints`,
    `  ${secondary}: handle empty response body`,
    `  ${tertiary}(readme): document required token permissions`,
    '',
    `Allowed types (configured with the "allowed-pr-types" input): ${allowedTypes.join(', ')}`,
    '',
    'Update the pull request title to continue.',
  ].join('\n');
}

interface PullRequestPayload {
  number?: number;
  title?: string;
}

/** Entry point for `pull_request` events: enforce a Conventional Commit title. */
export async function checkPrTitle(): Promise<void> {
  if (!getBooleanInput('enable-pr-title-check', true)) {
    core.info('PR title check is disabled ("enable-pr-title-check" is false). Skipping.');
    return;
  }

  const payload = github.context.payload as { pull_request?: PullRequestPayload };
  const pullRequest = payload.pull_request;
  if (!pullRequest) {
    core.warning('No pull_request payload found on this event. Skipping PR title check.');
    return;
  }

  const title = pullRequest.title ?? '';
  const allowedTypes = getListInput('allowed-pr-types', DEFAULT_PR_TYPES);
  const result = validatePrTitle(title, allowedTypes);

  if (result.ok) {
    const scope = result.scope ? `(${result.scope})` : '';
    const breaking = result.breaking ? '!' : '';
    core.info(`PR title is valid: ${result.type}${scope}${breaking}: ${result.description}`);
    core.setOutput('pr-title-valid', 'true');
    return;
  }

  core.setOutput('pr-title-valid', 'false');
  core.setFailed(buildFailureMessage(title, result.reason, allowedTypes));
}
