const COMMENT_MARKER = "<!-- geometrikks-container-smoke -->";

const STATUS_LABELS = {
  success: "✅ success",
  failure: "❌ failure",
  cancelled: "⚪ cancelled",
  skipped: "⏭️ skipped",
  timed_out: "⏱️ timed out",
  neutral: "➖ neutral",
  action_required: "⚠️ action required",
};

function statusLabel(conclusion) {
  return STATUS_LABELS[conclusion] ?? "⏭️ not run";
}

// The step names below must match the display names of the frontend job's
// steps in .github/workflows/ci.yml. Renaming a step there silently turns
// its row into "not run" here.
function buildComment({ workflowRun, jobs }) {
  const frontend = jobs.find((job) => job.name === "frontend");
  const steps = new Map(
    (frontend?.steps ?? []).map((step) => [step.name, step.conclusion]),
  );
  const artifactName = `container-smoke-${workflowRun.run_attempt}`;

  return `${COMMENT_MARKER}
## Production image smoke test

| Check | Result |
| --- | --- |
| Overall CI | ${statusLabel(workflowRun.conclusion)} |
| Frontend job | ${statusLabel(frontend?.conclusion)} |
| Build production image | ${statusLabel(steps.get("Build production image"))} |
| HTTP smoke checks | ${statusLabel(steps.get("Run HTTP smoke checks"))} |
| Browser smoke test | ${statusLabel(steps.get("Run browser smoke test"))} |
| Auth-disabled smoke | ${statusLabel(steps.get("Run auth-disabled smoke checks"))} |
| Artifact upload | ${statusLabel(steps.get("Upload smoke artifacts"))} |

[View workflow run and download \`${artifactName}\`](${workflowRun.html_url})`;
}

async function main({ github, context, core }) {
  const workflowRun = context.payload.workflow_run;
  // Known limitation: workflow_run.pull_requests is empty for PRs opened
  // from forks, so those get no sticky comment (the run link in the Checks
  // tab still works). If forks ever matter, resolve the PR via
  // repos.listPullRequestsAssociatedWithCommit on workflowRun.head_sha.
  const pullRequest = workflowRun.pull_requests?.[0];

  if (workflowRun.event !== "pull_request" || !pullRequest) {
    core.notice("No pull request is associated with this workflow run.");
    return;
  }

  const testedHeadSha = pullRequest.head?.sha;
  if (testedHeadSha) {
    const { data: currentPullRequest } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: pullRequest.number,
    });
    if (currentPullRequest.head.sha !== testedHeadSha) {
      core.notice("Skipping stale workflow run for an older PR head.");
      return;
    }
  }

  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRun,
    {
      ...context.repo,
      run_id: workflowRun.id,
      per_page: 100,
    },
  );
  const body = buildComment({ workflowRun, jobs });
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pullRequest.number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.includes(COMMENT_MARKER),
  );

  if (existing) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pullRequest.number,
    body,
  });
}

module.exports = {
  COMMENT_MARKER,
  buildComment,
  main,
};
