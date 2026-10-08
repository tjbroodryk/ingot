---
name: release
description: |
    Cuts an Ingot release: an annotated v* tag on main, which images.yml turns into published images and a Helm chart. Use when asked to cut, tag, ship or publish a release or a new version, or to check what the next release would contain.
---

# Cutting a release

A release is an annotated `vX.Y.Z` tag on `origin/main`. Pushing it is the
whole release: `.github/workflows/images.yml` builds the server and app images
and publishes the chart, stamping its version and appVersion from the tag.
Nothing in the repo is edited, and `Chart.yaml` is never bumped by hand.

`@ingotdb/sdk` (`packages/sdk`) is published to npm by hand and versions
independently. A tag does not publish it.

Everything except the release notes is done by `release.sh`, next to this
file. Run it from anywhere in the repo.

## 1. Plan

```sh
.claude/skills/release/release.sh plan
```

This fetches `origin`, then prints:

- the latest tag, the target commit (the tip of `origin/main`), and the next
  version. The version comes from the conventional-commit subjects since the
  last tag: `feat` or a breaking change bumps the minor while below 1.0,
  anything else bumps the patch. To pick a different version, run
  `plan --version vX.Y.Z`.
- the commits going out.
- the checks. **FAIL** blocks the release: an open `release/*` PR, a failed
  CI run on the target commit, or a target that isn't on main. **warn** means
  ask the user: other open PRs (one of them may be meant for this release),
  or CI on the target still running.
- facts for the upgrade notes: migrations added, `INGOT_` env vars that are
  new, whether `charts/ingot/values.yaml` or the SDK changed.
- the path of the draft notes it wrote (`.git/RELEASE_NOTES_vX.Y.Z`) and the
  exact `tag` command to run next.

If anything FAILs, stop and tell the user what is blocking. Don't work around
it.

## 2. Write the notes

Edit the draft and replace every `TODO`. `tag` refuses to run while any
`TODO` is left. The header lines are already correct; leave them alone.

For each change, say what it means for someone running Ingot, not how the
code changed. Read the commit bodies (`git log vLAST..TARGET`) and, if needed,
the diff. Keep the `type(scope):` prefix. Group related commits into one
bullet, and drop commits nobody running Ingot would notice (tests, CI,
refactors). Wrap at about 74 columns.

"Upgrading from" names every migration, with what it does, and every config
change: new env vars, changed defaults, chart values. Include an operator
step if one is needed, such as scaling a deployment down first. If nothing
applies, write `- No migrations or config changes.`

Earlier tags show the house style:

```sh
git tag -l --format='%(contents)' v0.9.0 v0.10.0 v0.11.0
```

## 3. Tag

Show the user the version and the finished notes before running this. If
`plan` printed warnings, get an explicit go-ahead first.

```sh
.claude/skills/release/release.sh tag vX.Y.Z --target <sha> --notes <file>
```

Use the `--target` that `plan` printed, not `main`. If main moved since the
plan, the notes describe the old commit, and `tag` refuses because the notes
name a different commit. `tag` also re-runs every check, then refuses if the
version exists or isn't newer than the latest tag. After that it creates and
pushes the tag, and prints the release build's run.

## 4. Watch

```sh
.claude/skills/release/release.sh watch vX.Y.Z
```

Run it in the background; it blocks until the build finishes, which takes
roughly 10–15 minutes. When it's done, it prints each job's result and exits
non-zero if the run did not succeed. A failed release build means the images
or chart were not published: report which job failed and its log
(`gh run view <id> --log-failed`). Don't delete or move the tag without the
user's say-so.
