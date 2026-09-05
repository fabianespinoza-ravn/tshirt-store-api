#!/usr/bin/env bash
# How many comments the review action has left on this pull request.
#
# The workflow calls it twice, before and after the review, and treats a
# number that did not grow as a review that never happened. That is the
# failure worth catching: the action reports a refusal to review — a
# workflow file that differs from main's, an expired token — as a
# successful run with no output, which looks exactly like a clean review.
#
# Only this one author counts. A person or another bot commenting while the
# job runs must not be able to satisfy the check on its behalf.
set -euo pipefail

AUTHOR='claude[bot]'

pr="$(jq -r '.pull_request.number' "${GITHUB_EVENT_PATH}")"

# Top-level comments live under `issues`, line comments under `pulls`, and
# the action posts both. `--paginate` with `--jq` prints one count per page,
# so the pages are summed rather than read as a single number.
total=0
for endpoint in issues pulls; do
  page_counts="$(
    gh api "repos/${GITHUB_REPOSITORY}/${endpoint}/${pr}/comments" --paginate \
      --jq "[.[] | select(.user.login == \"${AUTHOR}\")] | length"
  )"
  total=$((total + $(printf '%s\n' "${page_counts}" | awk '{ s += $1 } END { print s + 0 }')))
done

printf '%s\n' "${total}"
