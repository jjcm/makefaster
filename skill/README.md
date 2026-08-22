# Canonical speedup skill

`SKILL.md` in this directory is the **canonical, updated version of
[jjcm/speedupskill](https://github.com/jjcm/speedupskill)'s `SKILL.md`** — the
measured-technique catalog the makefaster loop draws its hypotheses from.

It lives here because the update could not be opened as a PR against
`jjcm/speedupskill` from the environment that produced it (no push access to
that repo). The file is the original document byte-for-byte, plus:

- a new **"Run it as a packaged loop: `npx makefaster`"** section (after the
  intro), describing CLI detection, the checklist import, the loop, the 5-miss
  stop rule, and the leaderboard submissions;
- one added **Sources** entry pointing at this repo.

To sync it upstream, copy `skill/SKILL.md` over `SKILL.md` in
`jjcm/speedupskill` verbatim.

The *operational* skill that `npx makefaster` hands to the agent is separate:
[`packages/skill/SKILL.md`](../packages/skill/SKILL.md).
