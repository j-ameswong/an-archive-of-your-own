# Decision: authenticate to AO3 with a session cookie

## Context

Authors can restrict a work to logged-in AO3 users. An anonymous request for one
returns HTTP 200 but redirects to `/users/login?restricted=true`, carrying no
metadata. 48 of 631 works in the database (~7.6%) have no `kudos` value, which
matches this population.

## Decision

Send an `_otwarchive_session` cookie, read from `AO3_SESSION` in a gitignored
root `.env`. Requests work without it; restricted works are then recorded as
`fetch_status = 'restricted'`.

## Alternatives

- **Record and skip.** Set `fetch_status = 'restricted'` and leave those rows
  without metadata. No credential to hold, but ~7.6% of the archive stays empty.
- **Fall back to fichub.net for restricted works.** Rejected — its data measured
  years out of date. See [ADR-0001](0001-scrape-ao3-directly.md).

## Rationale

A cookie is the only one of the three that actually retrieves the data. Verified
against `works/18400031` and `works/9710798`, both previously login-gated: each
returns a full page with a parseable meta block when the cookie is sent.

## Consequences

- A live credential sits on disk. `.env` is gitignored and mode `600`, and the
  contact address in `ARCHIVE_CONTACT` lives there for the same reason.
- `.env` is read at process start, so replacing an expired cookie needs a
  restart.
- A login redirect *while a cookie is set* is reported as `expired_session`
  rather than `restricted`, so a dead cookie is not mistaken for a restricted
  work.
- Automated requests are attributable to a real AO3 account, which makes the
  self-imposed rate limit a condition of use rather than a courtesy.
