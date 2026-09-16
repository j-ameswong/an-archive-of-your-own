# Parser fixtures

Real AO3 pages, captured 2026-09-16, with the fic body cut at
`<div id="chapters"` so no story text is stored here. Everything the parser
reads sits above that point.

| File | Covers |
|---|---|
| `work-complete-6623293.html` | finished multi-chapter work; every tag type but `relationship` |
| `work-in-series-20049589.html` | large tag lists; part of a series |
| `work-oneshot-3694820.html` | 1/1 finished the day it was posted, so AO3 prints no status row; also restricted, so the title carries a lock `<img>` |
| `work-ongoing-47011165.html` | undeclared chapter total (`11/?`); non-ascii author name |
| `work-coauthored-20631227.html` | two creators |
| `series-1637290.html` | series metadata; work listing cut off |

## Dates

AO3 renders timestamps in the logged-in account's timezone. The account behind
`AO3_SESSION` is set to UTC, so a page fetched with the cookie and the same page
fetched anonymously agree. Changing that preference would shift `published_at`
and `updated_at` by a day for some works.

## Refreshing

Re-capture with `fetchAo3`, cut at `<div id="chapters"`, and fail if that marker
is absent rather than writing a file with the story in it. Kudos, bookmarks and
`updated_at` move, so expected values in `parse.test.js` need updating with the
fixture.
