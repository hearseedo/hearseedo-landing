#!/usr/bin/env bash
# Verifies that deployment protection is actually enforced by GitHub, not just described in a workflow file.
# Usage: scripts/ci/verify-github-setup.sh owner/repo [environment ...]   (needs `gh` logged in with repo admin rights)
# Exits non-zero if anything is missing. Prints names and counts only, never secret values.
set -uo pipefail
repo="${1:?usage: verify-github-setup.sh owner/repo [environment ...]}"; shift
envs=("$@"); [ ${#envs[@]} -eq 0 ] && envs=(production)
fail=0; ok(){ echo "  PASS  $*"; }; bad(){ echo "  FAIL  $*"; fail=1; }
echo "== $repo"
vis=$(gh api "repos/$repo" --jq '.private' 2>/dev/null) && echo "  info  private=$vis (environment reviewers on private repos need a paid plan)"
for e in "${envs[@]}"; do
  echo "-- environment: $e"
  json=$(gh api "repos/$repo/environments/$e" 2>/dev/null) || { bad "environment '$e' does not exist, so nothing enforces approval"; continue; }
  n=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(len(r.get('reviewers',[])) for r in d.get('protection_rules',[]) if r['type']=='required_reviewers'))")
  [ "$n" -ge 1 ] && ok "required reviewers configured ($n)" || bad "no required reviewers on '$e'"
  echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((r.get('prevent_self_review') for r in d.get('protection_rules',[]) if r['type']=='required_reviewers'),None))" | grep -q True && ok "self-review prevented" || echo "  note  self-review is allowed (fine for a single owner; set a second reviewer if you add one)"
  echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);p=d.get('deployment_branch_policy');print('ok' if p else 'none')" | grep -q ok && ok "deployment limited to selected branches" || bad "'$e' can be deployed from any branch"
  gh api "repos/$repo/environments/$e/secrets" --jq '.secrets[].name' 2>/dev/null | grep -qx NETLIFY_AUTH_TOKEN && ok "NETLIFY_AUTH_TOKEN is an environment secret" || bad "NETLIFY_AUTH_TOKEN is not set on environment '$e'"
done
echo "-- secrets must NOT be repository-wide"
gh api "repos/$repo/actions/secrets" --jq '.secrets[].name' 2>/dev/null | grep -E 'NETLIFY|STRIPE|FIREBASE|SERVICE' && bad "deploy credentials exist as repository secrets (readable by any workflow run, including PRs from the repo)" || ok "no deploy credentials at repository level"
echo "-- branch protection on main"
gh api "repos/$repo/branches/main/protection" >/dev/null 2>&1 && ok "main is protected" || bad "main is not protected"
echo "-- actions policy"
perm=$(gh api "repos/$repo/actions/permissions/workflow" --jq '.default_workflow_permissions' 2>/dev/null); [ "$perm" = "read" ] && ok "default workflow token is read-only" || bad "default workflow token is '$perm' (should be read)"
fork=$(gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval" --jq '.approval_policy' 2>/dev/null); [ "$fork" = "all_external_contributors" ] && ok "all outside contributors need approval to run workflows" || echo "  FAIL  fork-PR approval policy is '${fork:-unknown}' (set 'require approval for all external contributors')" && [ "$fork" != "all_external_contributors" ] && fail=1
echo "-- workflow files (local)"
dir="$(git rev-parse --show-toplevel)/.github/workflows"
grep -l "pull_request_target" "$dir"/*.yml 2>/dev/null && bad "a workflow uses pull_request_target" || ok "no pull_request_target"
python3 - "$dir" <<'PY' || fail=1
import sys,glob,re
bad=0
for f in glob.glob(sys.argv[1]+'/*.yml'):
    t=open(f).read()
    on=re.search(r'^on:\n((?:[ \t].*\n)+)',t,re.M); trig=on.group(1) if on else ''
    if 'secrets.' in t and re.search(r'^\s+pull_request\b',trig,re.M):
        print('  FAIL  %s uses secrets and triggers on pull_request'%f.split('/')[-1]); bad=1
    if re.search(r'--prod|NETLIFY_AUTH_TOKEN',t) and 'environment:' not in t:
        print('  FAIL  %s deploys or uses the Netlify token without an environment'%f.split('/')[-1]); bad=1
print('  PASS  deploy workflows: no secrets on pull_request, every deploy uses an environment' if not bad else '')
sys.exit(bad)
PY
[ $fail -eq 0 ] && echo "RESULT: enforced" || echo "RESULT: NOT fully enforced"; exit $fail
