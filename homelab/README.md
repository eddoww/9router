# Maintained homelab branch

Upstream is `decolua/9router`, branch `master`. The maintained branch is
`eddoww/9router:homelab`; it is also this fork's default branch.

`Homelab Verified Image` runs hourly and on pushes/manual dispatch. It merges
upstream without rewriting local commits, runs the regression suite, builds a
Linux amd64 container with at most four build workers, and checks health and
unauthenticated access controls in an isolated container. All Kubernetes nodes
in the target cluster currently use amd64.

Only a successful candidate advances the maintained branch and publishes an
immutable `ghcr.io/eddoww/9router@sha256:...` image. A published GitHub release
contains `homelab-image.json`: source/upstream commits, digest, workflow run and
monotonic build number. Partial releases stay drafts. Previously published source
releases are never rebuilt or replaced.

The homelab repository checks that release every five minutes, validates the
manifest and commits the new digest to `k8s/ai-tools/9router.yaml`. ArgoCD applies
the Git change. No Kubernetes credentials or cross-repository write token are
given to this fork's workflow.

## Local patches

- Tool-free compaction of hosted search history uses regular Responses and
  explicitly disables new tool calls. Responses Lite cannot replay that history.
- Upstream generic SSE errors become terminal `response.failed` events, preserving
  their code and message for Codex recovery.
- Next, native dependency builds and regression runners use at most four workers
  and run at low priority.

Run the focused checks after installing root and `tests/` dependencies:

```sh
bash homelab/test.sh
```

Local regression files named `tests/unit/homelab-*.test.js` are included
automatically. Keep patch regression tests when upstream absorbs an equivalent
fix; remove the implementation delta only after verifying equivalent behavior.

## Failures and rollback

A merge conflict or failing test/build/smoke check fails the workflow and does
not publish a verified release. Resolve the conflict on `homelab`, retain the
regression tests, and push again.

The shared router uses a single SQLite writer and Kubernetes `Recreate`.
Deployments briefly drop existing streams; automatic client retries can recover.
Health probes do not prove every provider works, so preserve a pre-deploy database
backup before the first adoption and before releases with schema changes.

For rollback, disable the homelab image-promotion workflow before reverting the
digest and build marker in Git. Otherwise it would promote the newer release
again. A database migration may require restoring the corresponding backup.
