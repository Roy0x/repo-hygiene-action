import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  AUDIT_COMMENT_MARKER,
  Octokit,
  createClient,
  getBooleanInput,
  getRepo,
  toErrorMessage,
  upsertMarkerComment,
} from './utils';

interface AuditRule {
  id: string;
  label: string;
  regex: RegExp;
  secret?: boolean;
}

/** Patterns the diff auditor flags on added lines. */
export const AUDIT_RULES: AuditRule[] = [
  {
    id: 'console-log',
    label: 'Leftover `console.log`',
    regex: /console\.log\s*\(/,
  },
  {
    id: 'debugger',
    label: 'Leftover `debugger;` statement',
    regex: /\bdebugger\s*;/,
  },
  {
    id: 'todo',
    label: 'Unfinished `TODO:` marker',
    regex: /\bTODO:/,
  },
  {
    id: 'secret',
    label: 'Hard-coded credential',
    // OpenAI-style `sk-...` keys and AWS access key IDs.
    regex: /\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b/,
    secret: true,
  },
];

export interface AuditFinding {
  file: string;
  line: number;
  ruleId: string;
  ruleLabel: string;
  snippet: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  scannedFiles: number;
  skippedFiles: number;
}

interface AddedLine {
  line: number;
  content: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Walk a unified diff hunk and return the added lines with their new-file line numbers. */
export function extractAddedLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];
  let newLine = 0;
  let insideHunk = false;

  for (const raw of patch.split('\n')) {
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      insideHunk = true;
      continue;
    }

    if (!insideHunk) {
      continue;
    }

    // Skip file headers. A real added line such as `+++counter;` has no space after the prefix.
    if (/^(?:\+\+\+|---) /.test(raw)) {
      continue;
    }

    if (raw.startsWith('+')) {
      added.push({ line: newLine, content: raw.slice(1) });
      newLine += 1;
      continue;
    }

    if (raw.startsWith(' ')) {
      newLine += 1;
      continue;
    }

    // Removed lines (`-`) and "\ No newline at end of file" do not advance the new file.
  }

  return added;
}

function redact(content: string, secret: string): string {
  return content.split(secret).join('<redacted>');
}

/** Scan a single file patch for audit rule matches on added lines. */
export function scanPatch(file: string, patch: string): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const added of extractAddedLines(patch)) {
    for (const rule of AUDIT_RULES) {
      const match = rule.regex.exec(added.content);
      if (!match) {
        continue;
      }

      const rawSnippet = rule.secret ? redact(added.content, match[0]) : added.content;
      findings.push({
        file,
        line: added.line,
        ruleId: rule.id,
        ruleLabel: rule.label,
        snippet: rawSnippet.trim().slice(0, 160),
      });
      break; // One finding per line keeps the summary readable.
    }
  }

  return findings;
}

async function collectFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })) {
    for (const file of page.data) {
      if (file.status === 'removed') {
        continue;
      }
      // GitHub omits the patch for binary files and very large diffs.
      if (!file.patch) {
        skippedFiles += 1;
        core.info(`Skipping "${file.filename}": no text patch available.`);
        continue;
      }
      scannedFiles += 1;
      findings.push(...scanPatch(file.filename, file.patch));
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, scannedFiles, skippedFiles };
}

function codeSpan(text: string): string {
  const single = text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  if (!single.includes('`')) {
    return `\`${single}\``;
  }
  return `\`\` ${single.replace(/``/g, "''")} \`\``;
}

const MAX_TABLE_ROWS = 40;

function scannedNote(result: AuditResult, suffix = ''): string {
  const skipped =
    result.skippedFiles > 0
      ? ` (${result.skippedFiles} file(s) had no text patch and were skipped)`
      : '';
  return `<sub>Scanned ${result.scannedFiles} changed file(s) with Repo Hygiene Action${skipped}${suffix}.</sub>`;
}

/** Build the single summary comment for the audit run. */
export function buildAuditComment(result: AuditResult, failOnAudit: boolean): string {
  const { findings } = result;

  if (findings.length === 0) {
    return [
      '## ✅ Repo Hygiene Audit',
      '',
      'No leftover `console.log` calls, `debugger;` statements, `TODO:` markers, or hard-coded credentials were found in the added lines of this pull request.',
      '',
      scannedNote(result),
    ].join('\n');
  }

  const affectedFiles = new Set(findings.map((finding) => finding.file)).size;
  const rows = findings
    .slice(0, MAX_TABLE_ROWS)
    .map(
      (finding) =>
        `| ${codeSpan(finding.file)} | ${finding.line} | ${finding.ruleLabel} | ${codeSpan(finding.snippet)} |`,
    );

  const lines = [
    '## 🔍 Repo Hygiene Audit',
    '',
    `Found **${findings.length}** potential issue(s) in **${affectedFiles}** file(s) among the added lines of this pull request.`,
    '',
    '| File | Line | Finding | Added line |',
    '| :--- | ---: | :--- | :--- |',
    ...rows,
    '',
  ];

  if (findings.length > MAX_TABLE_ROWS) {
    lines.push(`_…and ${findings.length - MAX_TABLE_ROWS} more finding(s) not shown._`, '');
  }

  lines.push(
    failOnAudit
      ? 'This run is configured with `fail-on-audit: true`, so the check fails until these are addressed.'
      : 'This run is configured with `fail-on-audit: false`, so the check reports findings without failing the workflow.',
    '',
    scannedNote(result, ' This comment is updated on every push instead of being duplicated'),
  );

  return lines.join('\n');
}

export async function postSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  try {
    const action = await upsertMarkerComment({
      octokit,
      owner,
      repo,
      issueNumber: pullNumber,
      marker: AUDIT_COMMENT_MARKER,
      body,
    });
    core.info(`Audit summary comment ${action}.`);
  } catch (error) {
    // Forked PRs get a read-only GITHUB_TOKEN, so commenting can legitimately fail.
    core.warning(`Could not post the audit summary comment: ${toErrorMessage(error)}`);
  }
}

interface PullRequestPayload {
  number?: number;
}

/** Entry point for `pull_request` events: scan added lines and report a single summary comment. */
export async function auditPrDiff(): Promise<void> {
  if (!getBooleanInput('enable-pr-audit', true)) {
    core.info('PR audit is disabled ("enable-pr-audit" is false). Skipping.');
    return;
  }

  const pullRequest = (github.context.payload as { pull_request?: PullRequestPayload }).pull_request;
  const pullNumber = pullRequest?.number ?? github.context.issue.number;
  if (!pullNumber) {
    core.warning('No pull request number found on this event. Skipping PR audit.');
    return;
  }

  const { owner, repo } = getRepo();
  const octokit = createClient();
  const failOnAudit = getBooleanInput('fail-on-audit', false);
  const result = await collectFindings(octokit, owner, repo, pullNumber);

  core.setOutput('audit-findings', String(result.findings.length));
  core.info(
    `Audited ${result.scannedFiles} changed file(s); found ${result.findings.length} potential issue(s).`,
  );

  for (const finding of result.findings) {
    core.info(`- ${finding.file}:${finding.line} ${finding.ruleId} ${finding.snippet}`);
  }

  await postSummaryComment(octokit, owner, repo, pullNumber, buildAuditComment(result, failOnAudit));

  if (result.findings.length > 0 && failOnAudit) {
    core.setFailed(
      `Repo Hygiene Action found ${result.findings.length} audit issue(s) in the added lines of this pull request (fail-on-audit is enabled).`,
    );
  }
}
