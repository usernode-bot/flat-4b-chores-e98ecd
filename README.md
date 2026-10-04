# Flat 4B Chores

A weekly chore rotation for one flat. Each chore (bins, dishes, hoovering)
belongs to one person each week; everyone's turn moves on one person every
Monday, and any ticked chore unticks itself again for the new week.

## What it does

- **The week's chores** — the home screen lists each chore with whose turn
  it is this week ("Maya's turn"), when it's due ("due Friday"), and its
  done state for the current week.
- **Mark as done** — tapping "mark as done" ticks that chore off for the
  current week. The tick survives page reloads; next Monday it is unticked
  again and the turn has rotated on. Anyone in the flat can tick any chore.
- **Rotation** — computed from the calendar week, starting from the week the
  app shipped (the rotation anchor in `server.js`). The order is
  Maya → Jasper → Sophie, each chore offset by one so the named person
  starts first. Nothing needs updating by hand.
- **Read-only guests** — visitors without a Homeroom account can look at the
  chores; marking one done asks them to make an account.

## How it's built

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app already knows who is using it.
  No accounts to build.
- **Database** — the app has its own private Postgres database with a
  `chores` table: `name`, the rotation order (`people`, a text array),
  `due_day`, and `last_done_week` (the week the chore was last ticked, as a
  date). The three chores are seeded on boot while the table is empty.
- **API** — two routes:
  - `GET /api/chores` → `{ week, chores: [{ id, name, person, dueDay, done }] }`
    for the current week (guests may read).
  - `POST /api/chores/:id/done` → ticks one chore for the current week;
    needs an account, answers guests 401 `account_required`.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The design kit lives in `styles/tailwind-input.css`.

## Proposing changes

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Ask for a change**, and describe the
change in plain English. You can also run Claude Code against this repo
directly; start with `CLAUDE.md`, which carries the app-specific notes and
points at the platform rules.
