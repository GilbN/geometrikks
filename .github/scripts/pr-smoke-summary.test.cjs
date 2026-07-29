const assert = require("node:assert/strict");
const test = require("node:test");

let summary = {};
try {
  summary = require("./pr-smoke-summary.cjs");
} catch {
  // The first TDD run intentionally exercises the missing implementation.
}

test("buildComment reports failures and steps that did not run", () => {
  assert.equal(
    typeof summary.buildComment,
    "function",
    "buildComment must be implemented",
  );

  const body = summary.buildComment({
    workflowRun: {
      conclusion: "failure",
      html_url: "https://github.com/GilbN/geometrikks/actions/runs/123",
      run_attempt: 2,
    },
    jobs: [
      {
        name: "frontend",
        conclusion: "failure",
        steps: [
          { name: "Build production image", conclusion: "success" },
          { name: "Run HTTP smoke checks", conclusion: "failure" },
          { name: "Run browser smoke test", conclusion: "skipped" },
          { name: "Upload smoke artifacts", conclusion: "success" },
        ],
      },
    ],
  });

  assert.equal(
    body,
    `<!-- geometrikks-container-smoke -->
## Production image smoke test

| Check | Result |
| --- | --- |
| Overall CI | ❌ failure |
| Frontend job | ❌ failure |
| Build production image | ✅ success |
| HTTP smoke checks | ❌ failure |
| Browser smoke test | ⏭️ skipped |
| Artifact upload | ✅ success |

[View workflow run and download \`container-smoke-2\`](https://github.com/GilbN/geometrikks/actions/runs/123)`,
  );
});

test("main updates the existing smoke comment instead of adding a duplicate", async () => {
  assert.equal(typeof summary.main, "function", "main must be implemented");

  const comments = [
    {
      id: 7,
      user: { login: "github-actions[bot]" },
      body: "<!-- geometrikks-container-smoke -->\nold result",
    },
    {
      id: 8,
      user: { login: "maintainer" },
      body: "Keep this comment",
    },
  ];
  const jobs = [
    {
      name: "frontend",
      conclusion: "success",
      steps: [
        { name: "Build production image", conclusion: "success" },
        { name: "Run HTTP smoke checks", conclusion: "success" },
        { name: "Run browser smoke test", conclusion: "success" },
        { name: "Upload smoke artifacts", conclusion: "success" },
      ],
    },
  ];
  const github = {
    paginate: async (method, parameters) => (await method(parameters)).data,
    rest: {
      actions: {
        listJobsForWorkflowRun: async () => ({ data: jobs }),
      },
      pulls: {
        get: async () => ({ data: { head: { sha: "source-head-sha" } } }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        updateComment: async ({ comment_id, body }) => {
          comments.find((comment) => comment.id === comment_id).body = body;
        },
        createComment: async ({ body }) => {
          comments.push({
            id: 9,
            user: { login: "github-actions[bot]" },
            body,
          });
        },
      },
    },
  };
  const context = {
    repo: { owner: "GilbN", repo: "geometrikks" },
    payload: {
      workflow_run: {
        id: 123,
        event: "pull_request",
        head_sha: "synthetic-merge-sha",
        conclusion: "success",
        html_url: "https://github.com/GilbN/geometrikks/actions/runs/123",
        run_attempt: 1,
        pull_requests: [{ number: 42, head: { sha: "source-head-sha" } }],
      },
    },
  };

  await summary.main({ github, context, core: { notice() {} } });

  assert.equal(comments.length, 2);
  assert.match(comments[0].body, /\| Browser smoke test \| ✅ success \|/);
  assert.equal(comments[1].body, "Keep this comment");
});

test("main creates the first smoke comment when no marker comment exists", async () => {
  const comments = [];
  const github = {
    paginate: async (method, parameters) => (await method(parameters)).data,
    rest: {
      actions: {
        listJobsForWorkflowRun: async () => ({
          data: [{ name: "frontend", conclusion: "cancelled", steps: [] }],
        }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        updateComment: async () => {
          assert.fail("There is no existing comment to update");
        },
        createComment: async ({ issue_number, body }) => {
          comments.push({
            id: 1,
            issue_number,
            user: { login: "github-actions[bot]" },
            body,
          });
        },
      },
    },
  };
  const context = {
    repo: { owner: "GilbN", repo: "geometrikks" },
    payload: {
      workflow_run: {
        id: 456,
        event: "pull_request",
        conclusion: "cancelled",
        html_url: "https://github.com/GilbN/geometrikks/actions/runs/456",
        run_attempt: 1,
        pull_requests: [{ number: 43 }],
      },
    },
  };

  await summary.main({ github, context, core: { notice() {} } });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 43);
  assert.match(comments[0].body, /\| Overall CI \| ⚪ cancelled \|/);
});

test("main does not replace the comment with a stale workflow run", async () => {
  const comments = [
    {
      id: 7,
      user: { login: "github-actions[bot]" },
      body: "<!-- geometrikks-container-smoke -->\nnewer result",
    },
  ];
  const github = {
    paginate: async (method, parameters) => (await method(parameters)).data,
    rest: {
      actions: {
        listJobsForWorkflowRun: async () => ({
          data: [{ name: "frontend", conclusion: "cancelled", steps: [] }],
        }),
      },
      pulls: {
        get: async () => ({ data: { head: { sha: "new-head-sha" } } }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        updateComment: async ({ comment_id, body }) => {
          comments.find((comment) => comment.id === comment_id).body = body;
        },
        createComment: async () => {
          assert.fail("A stale run must not create a comment");
        },
      },
    },
  };
  const notices = [];
  const context = {
    repo: { owner: "GilbN", repo: "geometrikks" },
    payload: {
      workflow_run: {
        id: 789,
        event: "pull_request",
        head_sha: "synthetic-old-merge-sha",
        conclusion: "cancelled",
        html_url: "https://github.com/GilbN/geometrikks/actions/runs/789",
        run_attempt: 1,
        pull_requests: [{ number: 44, head: { sha: "old-source-head-sha" } }],
      },
    },
  };

  await summary.main({
    github,
    context,
    core: {
      notice(message) {
        notices.push(message);
      },
    },
  });

  assert.equal(
    comments[0].body,
    "<!-- geometrikks-container-smoke -->\nnewer result",
  );
  assert.deepEqual(notices, ["Skipping stale workflow run for an older PR head."]);
});

test("main skips runs whose payload has no PR association", async () => {
  const comments = [];
  const github = {
    paginate: async (method, parameters) => (await method(parameters)).data,
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [{ number: 45, state: "open", head: { sha: "head-sha" } }],
        }),
      },
      pulls: {
        get: async () => ({ data: { head: { sha: "head-sha" } } }),
      },
      actions: {
        listJobsForWorkflowRun: async () => ({
          data: [{ name: "frontend", conclusion: "success", steps: [] }],
        }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        updateComment: async () => {
          assert.fail("There is no existing comment to update");
        },
        createComment: async ({ issue_number, body }) => {
          comments.push({ issue_number, body });
        },
      },
    },
  };
  const notices = [];
  const context = {
    repo: { owner: "GilbN", repo: "geometrikks" },
    payload: {
      workflow_run: {
        id: 987,
        event: "pull_request",
        head_sha: "head-sha",
        conclusion: "success",
        html_url: "https://github.com/GilbN/geometrikks/actions/runs/987",
        run_attempt: 1,
        pull_requests: [],
      },
    },
  };

  await summary.main({
    github,
    context,
    core: { notice(message) { notices.push(message); } },
  });

  assert.equal(comments.length, 0);
  assert.deepEqual(notices, ["No pull request is associated with this workflow run."]);
});
