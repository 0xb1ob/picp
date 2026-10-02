Completeness check for job ${job_id}.

You see ONE research artifact and the exact task it was written for. Answer one
question: **does the artifact cover the task it was given?**

Task:

    ${task}

Artifact:

    ${artifact_path}

You are not judging quality — the gate does that. You are checking coverage:

- every part of the task is addressed somewhere in the artifact, or is named as
  an unknown/blocker;
- no part of the task is silently dropped;
- required sections exist, each with content under it: Goal; Acceptance;
  Non-goals; Evidence; Approach; File list; Implementation order; Constraints;
  Test plan; Unknowns/Blockers; Self-assessment.

Finish by calling `report_verdict` exactly once:

```
report_verdict({
  job_id: "${job_id}",
  verdict: "pass|revise",
  flags: {
    destructive_scope: false,
    scope_growth: false,
    blocking_unknowns: false
  },
  reasons: ["what you checked for coverage"],
  revisions: ["only when verdict is revise; one item per thing that is missing"]
})
```

`pass` means the task is fully covered. `revise` means something is missing, and
each `revisions` item names exactly one missing thing. Never restate the
artifact body, and never propose a design — missing is missing.
