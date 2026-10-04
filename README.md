# Flat 4B Chores

A tiny chore app for flat 4B, built on Homeroom. Right now it tracks one
job, the bins, and reminds whoever's turn it is the night before bin day.

## What it does

- **Bins card** — shows whose turn it is this week and which day the
  bins go out ("due Thursday").
- **Bin-night reminder** — a banner at the top of the screen from 5 pm
  on the day before bin day, and on bin day itself: "Bin night tomorrow:
  it's Sam's turn." It is shown when the app is opened; the platform has
  no push notifications, so nobody is alerted who doesn't open the app.
- **Rotation** — everyone who has joined, in turn order, with the
  current person marked "this week". The turn advances every Monday.
- **Join the rotation** — any signed-in Homeroom user can join, at the
  end of the turn order.
- **Bin day** — any signed-in member can set or change the weekly bin
  day; guests can look at everything but can't join or change it.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app always knows who is using it.
  Guests carry their own read-only token.
- **Database** — the app has its own Postgres. Two append-only tables:
  `household_members` (turn order = insertion order, rows never updated
  or deleted) and `bin_day_setting` (the latest row is the current bin
  day; the history is kept).
- **API** — `GET /api/rotation` (also works for guests), `POST /api/join`
  and `POST /api/bin-day` (signed-in only).
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme. The design kit lives in `styles/tailwind-input.css`.

## Changing this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in
the header, then **Ask for a change**. You can also run Claude Code
against this repo directly; start with `CLAUDE.md`, which carries the
app-specific notes and points at the platform rules.
