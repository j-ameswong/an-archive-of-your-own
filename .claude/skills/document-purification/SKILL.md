---
name: documentation-purification
description: Reviews project documentation and removes unnecessary changelogs, historical implementation details, migration narratives, and decision rationale from canonical documentation. Preserves meaningful historical information by moving changes to changelogs and significant architectural decisions or rationale to appropriately named Markdown files such as ADRs or history documents. Keeps canonical documentation concise, current, technically useful, and free of unnecessary fluff.
---

# Documentation Purification

## Purpose

Keep project documentation **current, concise, and descriptive of the system as it exists now**.

Canonical documentation should explain:

* What the system does
* How it is structured
* How to use or configure it
* Important constraints and behaviour
* Current architectural and implementation concepts

It should **not become a historical record of how the system arrived at its current state**.

Historical changes, design discussions, rejected alternatives, migration notes, and decision rationale should be moved to appropriately named Markdown files.

## Core Principle

> **Canonical documentation describes the present. Decision and history documents describe the past and why the present looks the way it does.**

When reviewing documentation, distinguish between information necessary to understand the current system and information that merely explains how or why it changed.

Keep the former.

Move or remove the latter.

Do not preserve historical context in canonical documentation merely because it is interesting.

## What to Remove From Canonical Documentation

Look for and remove or relocate:

### Change history

Examples:

* "Previously, the application used..."
* "This was changed from X to Y..."
* "Originally..."
* "Before version..."
* "As of..."
* "We recently..."
* "This used to..."
* "This was introduced in..."
* "In the previous implementation..."

### Change rationale

Examples:

* "We changed X because..."
* "The reason we chose Y was..."
* "This was necessary because the old approach..."
* "We decided to replace X with Y because..."
* "This approach was chosen after..."
* "We originally considered..."
* "We rejected X because..."

Canonical documentation should generally state **what the system does**, rather than narrate the decision process that produced it.

### Migration narratives

Remove historical migrations that no longer need to be performed, such as:

* Migration from an old framework
* Replacement of an old database
* Transition from an obsolete API
* Historical architecture migrations

Retain migration instructions only when they describe a **currently supported migration path**.

### Temporal language

Be suspicious of:

* "recently"
* "currently being migrated"
* "now uses"
* "no longer"
* "formerly"
* "originally"
* "previously"
* "after switching"
* "before we introduced"

Do not blindly remove temporal language. Rewrite it into a timeless description when it describes an important current state.

For example:

> "We recently migrated to PostgreSQL."

becomes:

> "The application uses PostgreSQL."

## What to Keep

Retain information necessary to understand or operate the current system:

* Current architecture
* Current technology choices
* Current APIs
* Current data models
* Current configuration
* Current workflows
* Current constraints
* Current dependencies
* Current setup instructions
* Current operational procedures
* Current supported behaviour
* Important caveats
* Security requirements
* Performance constraints
* Domain terminology

A concise explanation of **current behaviour** is not historical merely because it explains why that behaviour exists.

For example:

> "Authentication tokens expire after 30 minutes to limit the lifetime of compromised credentials."

is useful current documentation.

Whereas:

> "We originally used 24-hour tokens, but changed them to 30 minutes after discussing the security implications."

is historical decision context and should be moved to a decision record if worth preserving.

## Where Historical Information Goes

Do not simply delete meaningful historical information.

Move it to an appropriately named Markdown document.

### Changelog

Use `CHANGELOG.md` for user-visible or project-level changes:

* Features added
* Features removed
* Breaking changes
* Behaviour changes
* Important fixes
* Release-level changes

Keep entries concise.

Do not turn the changelog into a narrative of every implementation detail.

### Architecture Decision Records

Use ADRs for meaningful architectural and design decisions.

Recommended location:

```text
docs/decisions/
```

Use descriptive filenames:

```text
docs/decisions/0001-use-postgresql.md
docs/decisions/0002-adopt-jwt-authentication.md
docs/decisions/0003-use-event-driven-processing.md
```

An ADR should capture, where known:

* Decision
* Context
* Alternatives considered
* Rationale
* Consequences

Do not create an ADR for every trivial implementation change.

### Historical or Migration Documentation

For information that does not fit a changelog or ADR, use an appropriately named document such as:

```text
docs/history.md
docs/migrations.md
docs/archive/<topic>.md
```

Choose the destination based on the nature of the information.

## Creating Decision Records

When extracting a meaningful architectural decision, prefer an ADR.

Use a concise structure:

```markdown
# Decision: <decision>

## Context

<Relevant problem or constraints.>

## Decision

<What was decided.>

## Alternatives

<Important alternatives that were considered.>

## Rationale

<Why this decision was made.>

## Consequences

<Important benefits, costs, constraints, or trade-offs.>
```

**Never fabricate missing history.**

If the documentation establishes that a decision was made but does not explain why, record only what is known.

For example:

```markdown
## Rationale

The available documentation does not record the original rationale.
```

Do not infer that an approach was selected for performance, simplicity, security, cost, or any other reason unless project evidence supports it.

## Rewriting Rules

When removing historical language, rewrite the surrounding content so that it remains natural.

### Example

Before:

> The project was originally built using SQLite, but we later migrated to PostgreSQL because SQLite could not handle the expected workload.

After:

> The application uses PostgreSQL.

If the rationale is documented and worth preserving, record it separately in an ADR.

### Example

Before:

> We recently switched from Redux to React Context. This was done because the application became too small to justify Redux.

After:

> Application-wide state is managed using React Context.

Move the design decision to an ADR if significant.

### Example

Before:

> Previously, authentication was handled by session cookies. The project now uses JWTs.

After:

> Authentication uses JWTs.

If the migration itself is relevant, record it in migration documentation. If the choice of JWT is an architectural decision, record it in an ADR.

## Existing Changelogs and Decisions

Do not rewrite existing:

* `CHANGELOG.md`
* ADRs
* Decision records
* Migration histories
* Explicit historical documentation

unless explicitly instructed to do so.

Use them as destinations and sources of historical context.

Canonical documentation may contain a short reference to a relevant ADR when that helps explain an important current constraint.

For example:

> The system uses PostgreSQL. See [ADR-0001](decisions/0001-use-postgresql.md) for the architectural decision.

Do not reproduce the ADR's historical narrative in the main documentation.

## Avoid Documentation Bloat

Prefer:

* Short paragraphs
* Direct statements
* Tables where they improve scanning
* Examples where useful
* Clear headings
* Concrete terminology

Remove:

* Repetition
* Generic introductions
* Obvious statements
* Marketing language
* Speculative statements
* Long historical narratives
* Repeated rationale
* Unnecessary boilerplate

The goal is **high information density**, not simply the lowest possible word count.

Do not remove useful technical detail merely to make documentation shorter.

## Procedure

### 1. Inventory documentation

Identify relevant documentation and classify files as:

* Canonical/current documentation
* Changelogs
* Decision records
* Historical/migration documentation

### 2. Read the documentation

Understand the current system before editing.

Do not classify individual sentences in isolation when surrounding context changes their meaning.

### 3. Identify historical content

Look for:

* Changes
* Previous implementations
* Migration narratives
* Design alternatives
* Decision rationale
* Historical timelines
* Obsolete temporary states

### 4. Classify historical information

For each piece of historical information, choose:

* Remove entirely if it has no lasting value
* Move to `CHANGELOG.md`
* Move to an ADR
* Move to migration/history documentation

### 5. Create destination documents

Create appropriately named Markdown files when necessary.

Do not create unnecessary documents for trivial changes.

### 6. Rewrite canonical documentation

Make canonical documentation describe the current system directly.

Remove references to:

* What existed before
* What changed
* Why it changed
* Who decided it
* When it changed

unless that information is genuinely necessary to understand current behaviour.

### 7. Preserve useful cross-references

Where a historical decision explains an important current constraint, link to the relevant ADR rather than duplicating its contents.

### 8. Remove fluff

Remove unnecessary:

* Repetition
* Boilerplate
* Marketing language
* Obvious statements
* Excessive prose

Do not remove substantive technical information.

### 9. Check consistency

Verify that:

* Documentation describes the current implementation
* Obsolete implementations are not presented as current
* Links remain valid
* Terminology is consistent
* Moved information exists in its new location
* No historical rationale was fabricated
* No important operational information was lost

### 10. Report the work

Provide a concise summary of:

* Documents modified
* Historical information moved
* New decision/history files created
* Information deliberately removed
* Ambiguous historical statements that could not be confidently classified

## Important Constraints

### Never fabricate history

Do not invent:

* Dates
* Authors
* Reasons
* Alternatives
* Performance measurements
* Migration details
* Team discussions
* Requirements
* Decision makers

Only record historical rationale supported by available project evidence.

### Do not turn every change into an ADR

ADRs are for meaningful architectural or design decisions.

A typo fix, renamed variable, minor UI adjustment, or routine dependency update normally does not deserve an ADR.

### Do not destroy valuable history

The objective is to **separate history from canonical documentation**, not erase it.

If historical information appears valuable but has no obvious destination, create a narrowly scoped history document rather than silently discarding it.

### Do not over-explain the present

After removing historical material, resist replacing it with lengthy explanations.

Canonical documentation should communicate the current system efficiently.

## Completion Criteria

The task is complete when:

* Canonical documentation describes the current system without unnecessary historical narrative.
* Changelogs contain relevant project/release changes.
* Significant architectural decisions have appropriate ADRs.
* Migration or historical information has an appropriate dedicated document.
* Historical rationale is not duplicated throughout canonical documentation.
* No unsupported historical claims have been introduced.
* Documentation is concise, technically useful, and free of unnecessary fluff.
* All modified documentation remains internally consistent.

