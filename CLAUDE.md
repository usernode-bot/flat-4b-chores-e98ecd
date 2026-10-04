# Flat 4B Chores — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template (replaced)

The Homeroom starter template screen — its hero, the Press! example
(`/api/press`, `/api/leaderboard`, the `presses` table) and the
`usernode-starter-notice@1` block — was replaced by the real chores screen
in the app's first change (issue #5). Nothing of the template is left;
`README.md` describes the actual app.

The rule that still applies to every future rewrite: keep the
`usernode-dev-console@1` forwarder `<script>`, the bridge `<script>` and
the design kit — those are platform infrastructure and the app's look, not
template content.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Flat 4B Chores

A weekly chore rota for one flat. The screen shows whose turn it is for
three shared chores — bins, dishes and hoovering — and anyone in the flat
ticks a chore off for the week ("mark as done"; tapping again undoes).

- **Members join on first open.** A signed-in `GET /api/state` upserts the
  viewer into `members`, so the names on the rota are always real
  flatmates. Guests read but are never added, and every write needs an
  account.
- **Weeks roll over at midnight UTC on Monday.** `turns.week_start` is the
  Monday's date ('YYYY-MM-DD', computed in UTC); every Monday each chore
  moves to the next person, ticked off or not. Never compute the week from
  the server's local timezone.
- **Turn order** is `members ORDER BY joined_at, id` — first to open the
  app is first in the cycle. A week's turns are materialized once (missing
  `turns` rows inserted on first read), so someone joining mid-week cannot
  shift the current week; they enter the cycle next Monday.
- **`turns` rows are never deleted** — old weeks are the rota's history. A
  tick is the `done_*` columns on the current week's row, so it belongs to
  a chore-and-week and survives reloads.
- **The three chores are fixed** in this version (seeded once whenever the
  `chores` table is empty): no adding, renaming or deleting.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Sketch:** `design/sketch.html` is the sketch this app's creator was shown
  when they made it, and `design/sketch.json` says its job, layout and words.
  The first version keeps them; list any change under Assumptions.

- **Palette:** accent: sage green, from the sketch (already set in the kit's tokens); neutrals: the kit's warm greys
- **Signature element:** the rotation itself — each chore card shows not only
  who has it this week (the accent turn line) but who takes it next
  ("next: …"), so the weekly cycle is visible with no extra navigation. With
  one member, the "next" line is hidden.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  _(change their sizes in `tailwind.config.js` if you must, not their number)_
- **Words:** the sketch's words are kept — "mark as done", "rotates every
  Monday", "week of Monday …", turn line "{name}'s turn", due lines "due
  Friday/Thursday/Saturday". Two words were added: "next: {name}" (the
  signature element) and "undo" (the button once ticked). "done" is the
  ticked badge.
- **Both looks:** light and dark, following the viewer's Homeroom theme via
  the kept theme `<script>`; no theme picker and no fixed look — this is a
  utility screen, not a scene. The favicon's circle carries the light sage
  accent.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- `members`, `chores` and `turns` are public on purpose (member rows hold
  only platform ids and public usernames); nothing here is
  `staging:private`.
- The boot seed gives staging three obviously fake members ("Staging demo
  Maya/Jasper/Sophie", fixed fake ids 900001–900003); real viewers are
  appended after them by the normal first-open path.
- No new dependencies; keep the styling to the design kit's tokens and
  components in `styles/tailwind-input.css`.
