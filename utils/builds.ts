import * as fs from 'fs';
import * as path from 'path';

export interface Build {
  id: string;     // = results folder name (branch name; branch__repo when the same branch exists in two repos)
  dir: string;    // results folder name
  repo: string;   // repository name as shown in Testable
  branch: string;
}

/**
 * Input: builds.json  →  { "repo": "<repo>", "branches": ["b1", "b2", ...] }   (run in this order)
 *        Different repos in one run: "branches": [ {"repo":"owner/repoA","branch":"b1"}, {"repo":"owner/repoB","branch":"b2"} ]
 *        Whole links:  "branches": [ "https://github.com/owner/repo/tree/branch-1", "https://github.com/owner/repo/tree/branch-2" ]  (no "repo" needed)
 * Overrides: REPO="<repo>" BRANCHES="b1,b2" (PowerShell: $env:BRANCHES="b1,b2").
 */
export function loadBuilds(): Build[] {
  const file = process.env.BUILDS_FILE || path.join(__dirname, '..', 'builds.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo: string = process.env.REPO || cfg.repo;
  // a branch is either "name" (uses the top-level repo) or { "repo": "...", "branch": "..." } (its own repo)
  const branches: Array<string | { repo?: string; branch: string }> = process.env.BRANCHES
    ? process.env.BRANCHES.split(',').map((s) => s.trim()).filter(Boolean)
    : cfg.branches ?? [];
  // a whole GitHub link "https://github.com/<owner>/<repo>/tree/<branch>" gives both the repo and the branch
  const fromLink = (s: string) => /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/(.+?)\/?$/i.exec(s.trim());
  const list = branches.map((b) => {
    const raw = typeof b === 'string' ? b : b.branch;
    const m = fromLink(raw);
    if (m) return { branch: decodeURIComponent(m[2]), repo: m[1] };
    return { branch: raw, repo: (typeof b === 'string' ? undefined : b.repo) || repo };
  });
  // same branch name in two repos → the results folder gets the repo name added so they never overwrite each other
  const count = new Map<string, number>();
  list.forEach((x) => count.set(x.branch, (count.get(x.branch) || 0) + 1));
  return list.map((x) => {
    const dir = (count.get(x.branch) || 0) > 1 ? `${x.branch}__${x.repo.split('/').pop()}` : x.branch;
    return { id: dir, dir, repo: x.repo, branch: x.branch };
  });
}
