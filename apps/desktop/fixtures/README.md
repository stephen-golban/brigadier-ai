# Plan cards

Run `pnpm dev --port 1426` in `apps/desktop`, then open
`http://localhost:1426/fixtures/plan-cards.html`. All data is synthetic; commands are
recorded in `window.planFixtureCalls` and never reach a daemon. This entry is absent
from the production build. Set `window.planFixtureFailNext = true` to exercise a
recoverable command error.

The gallery renders normal approval/review/revision/rejection and all three approval
origins, overnight proposals (including bare goals, invalid restrictions and power
risks), preparation, planning, work, checks, both fix rounds, limits, wind-down,
reporting, partial completion and full completion. The active fifth phase remains
visible past the initial four rows. Expand criteria, use Show N more, open a worker,
and exercise Start/Stop/Merge/Continue/Read report against the fixture actions.

Use `?summary=1` for the actual pinned summary and its thread links. Check a wide
window and a 320px window: the same normal cards appear beneath the context card,
and View plan opens the floating summary at narrow widths. Earlier revision links
open the current card, whose history folds. The summary fixture holds only normal plans; the application adapter uses real run records when present.

Check both density modes; Tab through folds, worker/report links and buttons, and use
Enter or Space to activate them. The `/overnight` menu item only prepares a draft.
Normal approval/rejection still sends `decidePlan`; automatic normal proposals have
no user Start or approval control. Stop settles after one successful fixture call;
Continue creates another proposal and requires Start.
