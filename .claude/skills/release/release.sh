#!/usr/bin/env bash
# Cut an Ingot release: an annotated v* tag on main. Pushing the tag is the
# release — .github/workflows/images.yml builds the images and publishes the
# chart from it.
#
#   release.sh plan  [--version vX.Y.Z]
#   release.sh tag   vX.Y.Z --target <sha> --notes <file>
#   release.sh watch vX.Y.Z
#
# `plan` changes nothing. `tag` refuses unless every check `plan` runs still
# passes, so a plan that went stale between the two cannot be tagged.
set -euo pipefail

WORKFLOW=images.yml
MIGRATIONS=apps/ingot/drizzle
VALUES=charts/ingot/values.yaml
SDK=packages/sdk

die() { echo "error: $*" >&2; exit 1; }
ok() { echo "  ok    $*"; }
warn() { echo "  warn  $*"; WARNINGS=$((WARNINGS + 1)); }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }

cd "$(git rev-parse --show-toplevel)"

fetch() {
  git fetch --quiet --tags --force origin main
}

latest_tag() {
  git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1
}

short() { git rev-parse --short=7 "$1"; }

# Conventional-commit subjects since the last tag decide the bump. Below 1.0 a
# breaking change is a minor bump, as v0.3.0 was.
next_version() {
  local last=$1 target=$2 major minor patch breaking feat
  IFS=. read -r major minor patch <<<"${last#v}"
  breaking=$(git log --no-merges --format='%s%n%b' "$last..$target" |
    grep -cE '^[a-z]+(\([^)]*\))?!:|^BREAKING CHANGE' || true)
  feat=$(git log --no-merges --format='%s' "$last..$target" |
    grep -cE '^feat(\([^)]*\))?!?:' || true)

  if [ "$breaking" -gt 0 ] && [ "$major" -gt 0 ]; then
    echo "v$((major + 1)).0.0"
  elif [ "$breaking" -gt 0 ] || [ "$feat" -gt 0 ]; then
    echo "v$major.$((minor + 1)).0"
  else
    echo "v$major.$minor.$((patch + 1))"
  fi
}

# The checks both `plan` and `tag` run. Sets FAILURES and WARNINGS.
run_checks() {
  local target=$1 open release_prs runs
  FAILURES=0
  WARNINGS=0

  git merge-base --is-ancestor "$target" origin/main ||
    fail "$(short "$target") is not on origin/main"

  open=$(gh pr list --state open --json number,headRefName,title \
    -q '.[] | "#\(.number) \(.headRefName) — \(.title)"')
  release_prs=$(grep -E '^#[0-9]+ release/' <<<"$open" || true)
  if [ -n "$release_prs" ]; then
    fail "open release PRs (merge them first, or this release ships without them):"
    sed 's/^/          /' <<<"$release_prs"
  else
    ok "no open release/* PRs"
  fi
  other=$(grep -vE '^#[0-9]+ release/' <<<"$open" | sed '/^$/d' || true)
  if [ -n "$other" ]; then
    warn "other open PRs — confirm none is meant for this release:"
    sed 's/^/          /' <<<"$other"
  fi

  # main's runs only; a tag's own release build shares the commit
  runs=$(gh run list --commit "$target" --json workflowName,headBranch,status,conclusion \
    -q '.[] | select(.headBranch == "main") | "\(.workflowName) \(.status) \(.conclusion)"')
  if [ -z "$runs" ]; then
    warn "no CI runs found for $(short "$target")"
  else
    while read -r name status conclusion; do
      if [ "$status" != completed ]; then
        warn "CI $name on $(short "$target") is $status"
      elif [ "$conclusion" = success ] || [ "$conclusion" = skipped ]; then
        ok "CI $name on $(short "$target"): $conclusion"
      else
        fail "CI $name on $(short "$target"): $conclusion"
      fi
    done <<<"$runs"
  fi
}

# Facts the "Upgrading from" section has to account for.
facts() {
  local last=$1 target=$2 migrations envs
  migrations=$(git diff --name-only --diff-filter=A "$last" "$target" -- "$MIGRATIONS" |
    grep '\.sql$' | xargs -n1 basename 2>/dev/null || true)
  envs=$(comm -13 \
    <(git grep -hoE 'INGOT_[A-Z0-9_]+' "$last" -- apps charts 2>/dev/null | sed 's/^[^:]*://' | sort -u) \
    <(git grep -hoE 'INGOT_[A-Z0-9_]+' "$target" -- apps charts 2>/dev/null | sed 's/^[^:]*://' | sort -u))

  echo "  migrations:      ${migrations:-none}" | paste -sd' ' -
  echo "  new INGOT_ vars: ${envs:-none}" | paste -sd' ' -
  if git diff --quiet "$last" "$target" -- "$VALUES"; then
    echo "  chart values:    unchanged"
  else
    echo "  chart values:    CHANGED ($VALUES)"
  fi
  if git diff --quiet "$last" "$target" -- "$SDK"; then
    echo "  sdk:             unchanged"
  else
    echo "  sdk:             CHANGED — @ingotdb/sdk is published to npm by hand, not by this tag"
  fi
}

draft_notes() {
  local version=$1 last=$2 target=$3 migrations
  migrations=$(git diff --name-only --diff-filter=A "$last" "$target" -- "$MIGRATIONS" |
    grep '\.sql$' || true)

  echo "$version"
  echo
  echo "Chart ${version#v} and images built from $(short "$target")."
  echo
  echo "Since $last:"
  echo
  git log --no-merges --reverse --format='- %s%n  TODO: what changed, for someone running Ingot' "$last..$target"
  echo
  echo "Upgrading from ${last#v}:"
  echo
  if [ -z "$migrations" ]; then
    echo "- No migrations."
  else
    echo "- TODO: migrations $(xargs -n1 basename <<<"$migrations" | paste -sd, -)"
  fi
  echo "- TODO: config changes, or delete this line"
}

cmd_plan() {
  local version="" last target notes
  while [ $# -gt 0 ]; do
    case $1 in
      --version) version=$2; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  fetch
  last=$(latest_tag)
  [ -n "$last" ] || die "no v* tag to release from"
  target=$(git rev-parse origin/main)

  [ "$(git rev-list --count --no-merges "$last..$target")" -gt 0 ] ||
    die "nothing on origin/main since $last"

  [ -n "$version" ] || version=$(next_version "$last" "$target")

  echo "latest:  $last"
  echo "target:  $(short "$target") (origin/main) $(git log -1 --format=%s "$target")"
  echo "version: $version"
  echo
  echo "commits since $last:"
  git log --no-merges --reverse --format='  %h %s' "$last..$target"
  echo
  echo "checks:"
  run_checks "$target"
  echo
  echo "facts:"
  facts "$last" "$target"

  notes="$(git rev-parse --absolute-git-dir)/RELEASE_NOTES_$version"
  draft_notes "$version" "$last" "$target" >"$notes"
  echo
  echo "draft notes: $notes"
  echo "next:        release.sh tag $version --target $(short "$target") --notes $notes"
  echo
  echo "failures: $FAILURES  warnings: $WARNINGS"
  [ "$FAILURES" -eq 0 ]
}

cmd_tag() {
  local version=${1:-} target="" notes="" last full
  [ -n "$version" ] || die "usage: release.sh tag vX.Y.Z --target <sha> --notes <file>"
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --target) target=$2; shift 2 ;;
      --notes) notes=$2; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$target" ] && [ -n "$notes" ] || die "--target and --notes are both required"
  [ -f "$notes" ] || die "no notes file at $notes"
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$version is not vMAJOR.MINOR.PATCH"

  fetch
  full=$(git rev-parse --verify "$target^{commit}") || die "unknown commit $target"
  last=$(latest_tag)

  git rev-parse -q --verify "refs/tags/$version" >/dev/null && die "$version already exists"
  [ "$(printf '%s\n%s\n' "$last" "$version" | sort -V | tail -1)" = "$version" ] ||
    die "$version is not after $last"

  [ "$(head -1 "$notes")" = "$version" ] || die "notes must start with a line reading $version"
  grep -q "built from $(short "$full")\." "$notes" ||
    die "notes must say \"built from $(short "$full").\" — they describe another commit"
  grep -q "^Since $last:" "$notes" || die "notes must have a \"Since $last:\" section"
  grep -q "TODO" "$notes" && die "notes still contain TODO"

  echo "checks:"
  run_checks "$full"
  [ "$FAILURES" -eq 0 ] || die "$FAILURES check(s) failed; not tagging"

  git tag -a "$version" "$full" -F "$notes"
  git push --quiet origin "refs/tags/$version"
  echo
  echo "pushed $version at $(short "$full")"
  cmd_watch_id "$version"
}

# The images run for a tag appears a few seconds after the push.
cmd_watch_id() {
  local version=$1 id="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    id=$(gh run list --workflow "$WORKFLOW" --branch "$version" --limit 1 --json databaseId -q '.[0].databaseId')
    [ -n "$id" ] && break
    sleep 5
  done
  [ -n "$id" ] || die "no $WORKFLOW run for $version after 60s"
  echo "run: $id  ($(gh run view "$id" --json url -q .url))"
  echo "watch: release.sh watch $version"
}

cmd_watch() {
  local version=${1:-} id
  [ -n "$version" ] || die "usage: release.sh watch vX.Y.Z"
  id=$(gh run list --workflow "$WORKFLOW" --branch "$version" --limit 1 --json databaseId -q '.[0].databaseId')
  [ -n "$id" ] || die "no $WORKFLOW run for $version"

  gh run watch "$id" --exit-status --interval 30 >/dev/null 2>&1 || true
  gh run view "$id" --json conclusion,url,jobs \
    -q '"conclusion: \(.conclusion)\nurl: \(.url)", (.jobs[] | "  \(.conclusion)  \(.name)")'
  [ "$(gh run view "$id" --json conclusion -q .conclusion)" = success ]
}

case ${1:-} in
  plan) shift; cmd_plan "$@" ;;
  tag) shift; cmd_tag "$@" ;;
  watch) shift; cmd_watch "$@" ;;
  *) die "usage: release.sh plan|tag|watch (see the header of this file)" ;;
esac
