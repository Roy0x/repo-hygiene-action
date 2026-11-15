import * as core from '@actions/core';
import * as github from '@actions/github';
import { auditPrDiff } from './auditPrDiff';
import { checkPrTitle } from './checkPrTitle';
import { triageIssue } from './triageIssue';
import { toErrorMessage } from './utils';

const PR_TITLE_EVENTS = new Set(['opened', 'edited', 'synchronize']);
const PR_AUDIT_EVENTS = new Set(['opened', 'synchronize']);

async function runStep(name: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    core.setFailed(`${name} failed: ${toErrorMessage(error)}`);
  }
}

async function run(): Promise<void> {
  const eventName = github.context.eventName;
  const action = String((github.context.payload as { action?: unknown }).action ?? 'n/a');
  core.info(`Repo Hygiene Action started for the "${eventName}" event (action: "${action}").`);

  switch (eventName) {
    case 'issues': {
      if (action !== 'opened' && action !== 'edited') {
        core.info(`Issue action "${action}" is not handled. Supported actions: opened, edited.`);
        return;
      }
      await runStep('Issue triage', triageIssue);
      return;
    }

    case 'pull_request': {
      if (!PR_TITLE_EVENTS.has(action) && !PR_AUDIT_EVENTS.has(action)) {
        core.info(
          `Pull request action "${action}" is not handled. Supported actions: opened, edited, synchronize.`,
        );
        return;
      }

      if (PR_TITLE_EVENTS.has(action)) {
        await runStep('PR title check', checkPrTitle);
      }
      if (PR_AUDIT_EVENTS.has(action)) {
        await runStep('PR diff audit', auditPrDiff);
      }
      return;
    }

    default:
      core.info(
        `Event "${eventName}" is not supported. This action handles "issues" and "pull_request" events.`,
      );
  }
}

void run().catch((error: unknown) => {
  core.setFailed(`Repo Hygiene Action failed unexpectedly: ${toErrorMessage(error)}`);
});
