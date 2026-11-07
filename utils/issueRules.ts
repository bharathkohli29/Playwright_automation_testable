import type { Conclusion, Candidate } from './rcaTrail';

/**
 * KNOWN PLATFORM PROBLEMS, written from what the platform code shows (rules from solved cases, like the rules for the failed tools):
 * when the problem text matches, the report gets the mechanism, the causes that fit the code, the fix, the workaround and how to check it, even when the
 * cluster cannot be read or the model could not follow the data to its source. A rule is added here, with a unit test, each time a problem is understood.
 * Each rule says which code it was read from, so a person can check it; the lead confirms it by keeping it or changing it.
 */
export interface IssueRule {
  id: string; match: RegExp; source: string; owner: string; mechanism: string; chain: string[]; candidates: Candidate[]; fix: string; workaround: string; verify: string; next: string;
}

export const ISSUE_RULES: IssueRule[] = [
  {
    id: 'branch-not-on-run-plan',
    match: /selected branch is not on this run plan/i,
    source: 'read in the platform code at origin/qa cdecb6bac: WhiteboxRunPlanCard.tsx:227, whitebox-chat-flow.ts:29-51, whitebox-confidence-trigger.ts:306',
    owner: 'Platform (mirror sync / branch catalog) or the script (it opens the plan before the branch is mirrored)',
    mechanism: 'The Run plan card lists only the branches of the plan that match the selected branch name (strict match). The plan is built from listBranches(repositoryId, { limit: 200 }), the platform\'s mirrored branch catalog. When the selected branch is not in that list, the list is empty, the card shows "The selected branch is not on this run plan yet." and Execute run stays disabled.',
    chain: ['The script opens the Run plan for the branch', 'The page shows "The selected branch is not on this run plan yet." and Execute run is disabled', 'In the code the card lists only the branches found in the plan: listed.length === 0', 'The plan comes from the branch catalog: listBranches(repositoryId, limit 200)', 'The catalog has no entry for the branch: not mirrored yet, more than 200 branches, or a different name'],
    candidates: [
      { cause: 'The branch was not mirrored into the catalog yet (it was just pushed or created, for example by the dummy commit, and the mirror sync had not finished)', confirm: 'The mirror sync status of the repository, and whether the branch is in the list of "Change repository / branch" a few minutes later' },
      { cause: 'The repository has more than 200 branches, and the catalog call only reads the first 200', confirm: 'The number of branches of the repository in the catalog (more than 200 means the branch can fall outside the list)' },
      { cause: 'The branch name on the platform differs from the selected one (a different spelling or prefix, normalised before the match)', confirm: 'The branch name in the catalog next to the name the script selected' },
    ],
    fix: 'Platform: read the catalog beyond 200 branches (page through it) and show the mirror sync status on the run plan card, so a missing branch says "still syncing". Script: before it opens the run plan, wait until the branch is in the catalog (poll "Change repository / branch" or Repository history) and select it again, instead of going on with an empty list.',
    workaround: 'Wait for the mirror sync of the repository to finish, then open "Change repository / branch", select the branch again and reopen the run plan.',
    verify: 'The branch is listed on the Run plan card and the Execute run button is enabled.',
    next: 'Check the mirror sync status of the repository and the number of branches in the catalog.',
  },
];

export function matchIssueRule(text: string): IssueRule | null { return ISSUE_RULES.find((r) => r.match.test(text)) || null; }

/** the conclusion after the rule: what the model established stays; what it could not establish (or did not say) comes from the rule */
export function applyRule(c: Conclusion | null, rule: IssueRule): Conclusion {
  const established = !!c && !/^not established/i.test(c.cause) && c.proof !== 'Unknown';
  return {
    mechanism: rule.mechanism, chain: rule.chain, rule: `${rule.id} (${rule.source})`,
    cause: established ? c!.cause : 'Not established without the cluster: three causes fit the platform code (see the list below).',
    proof: established ? c!.proof : 'Unknown', evidence: c?.evidence || '', owner: c?.owner || rule.owner,
    next: rule.next, candidates: rule.candidates, fix: rule.fix, workaround: rule.workaround, verify: rule.verify,
  };
}
