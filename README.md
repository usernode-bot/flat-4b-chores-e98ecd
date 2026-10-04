# Flat 4B Chores

A weekly chore rota for one flat. The screen shows whose turn it is for
**bins**, **dishes** and **hoovering** this week, and anyone in the flat
ticks a chore off with **mark as done** — tap again to undo.

- **Whose turn** — each chore card shows who has it this week, the day
  it's due, and who takes it next week.
- **Rotation** — every Monday at midnight UTC each chore moves to the
  next person in the flat, ticked off or not.
- **Real names** — you join the rota the first time you open the app, so
  the names on it are always real flatmates. People without a Homeroom
  account can look at the rota, but ticking asks them to make an account
  first.
- **Under the hood** — the platform's auth (no accounts to build), the
  app's own Postgres database (`members`, `chores` and `turns` tables),
  two Express routes (`GET /api/state`,
  `POST /api/chores/:id/done`), and Tailwind compiled at build time in a
  light and a dark look that follow the viewer's Homeroom theme.

## Changing this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Ask for a change**, and describe what you want in plain
English. You can also run Claude Code against this repo directly; start
with `CLAUDE.md`, which carries the app-specific notes (the week
boundary, how joining works, the design) and points at the platform
rules.
