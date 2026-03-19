# Skills Guidelines

This document codifies how Pixymon work should use skill-style instructions, scripts, references, and verification assets.

## 1. When To Create Or Use A Skill

Create or rely on a skill only when the task contains non-obvious leverage:

1. library or API usage that the model often gets wrong
2. product verification workflows
3. data fetching and analysis workflows
4. business/team automation workflows
5. scaffolding and repeatable templates
6. code quality and review workflows
7. CI/CD or deployment workflows
8. runbooks for incident investigation
9. infrastructure operations with guardrails

If the task is obvious to a strong coding model, do not create a skill for it.

## 2. Skill Design Rules

1. Do not restate obvious coding knowledge.
2. Focus on gotchas, footguns, edge cases, and failure modes.
3. Prefer progressive disclosure:
   - keep the main instruction short
   - move detailed examples into `references/`
   - keep reusable scripts in `scripts/`
   - keep templates in `assets/`
4. Prefer code and scripts over large prose blocks.
5. Avoid railroading the agent with overly rigid prose.
6. If setup data is required, store it as explicit config, not hidden assumptions.
7. If memory is useful, store it in a stable project path, not ephemeral workspace state.

## 3. Skill Verification Rules

1. Every skill-like workflow should define how success is verified.
2. Verification should prefer deterministic scripts or programmatic checks.
3. If a workflow cannot be verified, document the residual risk explicitly.
4. For Pixymon work, verification must state one of:
   - build/test proof
   - runtime observation proof
   - output quality proof

## 4. Skill Maintenance Rules

1. Add new gotchas when the agent fails in a repeated way.
2. Do not publish duplicate or overlapping skills without a clear reason.
3. Prefer composition over giant all-in-one skills.
4. Track useful scripts, references, and examples in-repo so future workspaces can reuse them.

## 5. Pixymon-Specific Interpretation

For this repo, the practical meaning is:

1. if a workflow is repeated, encode it in docs/scripts/tests instead of re-explaining it in chat
2. if output quality repeatedly fails, capture the failure as a gotcha or deterministic test
3. if an operational loop depends on external systems, write the runbook before tuning prompts
4. if a task touches product quality, define the verification surface first
