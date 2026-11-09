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

// The step names below must match the display names of the smoke job's
// steps in .github/workflows/ci.yml, and the job names its matrix name.
// Renaming either there silently turns a cell into "not run" here.
const SMOKE_JOB_NAME = /^smoke (\d+)\/(\d+)$/;
const SMOKE_STEPS = [
  "Build production image",
  "Run HTTP smoke checks",
  "Run browser smoke test",
  "Upload smoke artifacts",
];

const shardNumber = (job) => Number(job.name.match(SMOKE_JOB_NAME)[1]);

function shardRow(job) {
  const steps = new Map((job.steps ?? []).map((step) => [step.name, step.conclusion]));
  const [, shard, total] = job.name.match(SMOKE_JOB_NAME);
  const cells = SMOKE_STEPS.map((name) => statusLabel(steps.get(name)));
  return `| ${shard}/${total} | ${statusLabel(job.conclusion)} | ${cells.join(" | ")} |`;
}

function buildComment({ workflowRun, jobs }) {
  const shards = jobs
    .filter((job) => SMOKE_JOB_NAME.test(job.name))
    .sort((a, b) => shardNumber(a) - shardNumber(b));
  const shardRows = shards.length > 0
    ? shards.map(shardRow).join("\n")
    : `| all | ${statusLabel(undefined)} | ${SMOKE_STEPS.map(() => statusLabel(undefined)).join(" | ")} |`;

  return `${COMMENT_MARKER}
## Production image smoke test

| Check | Result |
| --- | --- |
| Overall CI | ${statusLabel(workflowRun.conclusion)} |

| Shard | Job | Build production image | HTTP smoke checks | Browser smoke test | Artifact upload |
| --- | --- | --- | --- | --- | --- |
${shardRows}

[View the workflow run and its \`container-smoke-<shard>-<attempt>\` artifacts](${workflowRun.html_url})`;
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
