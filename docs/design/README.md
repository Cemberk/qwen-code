# Design Documentation Requirements

Design documents describe proposed changes, their rationale, and how to verify
them. Store them under `docs/design/` and follow the requirements below when
creating or updating a design. Designs are written in English only.

## File naming

- Name the file `<name>.md`, with a date prefix where useful.
- Preserve existing document paths where possible. If a path or heading anchor
  changes, update its incoming references in the same change.

## Content

- Cover, wherever they apply: the problem statement, current state, goals,
  scope boundaries, proposed solution, design decisions and rationale,
  constraints, risks, validation plan, acceptance criteria, and open
  questions.
- Keep the status current, and distinguish proposals, implemented behavior,
  and verified results.
- Reflect new decisions, implementation constraints, acceptance criteria, and
  follow-up work in the same change that introduces them.

## Review checklist

- Decisions, limitations, acceptance criteria, and follow-up work are stated.
- Technical identifiers, examples, links, and assets are correct.
- The status reflects the changes proposed in the PR.
- Markdown formatting and relative links have been checked.
