# Invite Board

A leaderboard of who invited whom on Homeroom, with join counts per invite
link.

- **Leaderboard**: every person who created invite links, ranked by total
  joins, with each link's own count and the people it brought in.
- **My invites**: your links, their status (active, expired, used up), uses
  left, and who joined through each one. One tap to copy a share link.
- **Create link**: pick an expiry in days (or never) and a max-use cap
  (or unlimited). Joins are recorded when someone opens the app through
  your link; a person counts for the first invite that brought them here,
  once ever.

## How it works

- `invite_links` holds each link (random 8-char code, optional expiry and
  use cap). `invite_joins` records each join with a UNIQUE invitee, so one
  person can only ever be counted once.
- Self-invites, expired links and used-up links are refused with a reason
  the UI shows.
- Staging previews seed a few obviously-fake links and joins
  (`staging-demo-*` users) so the board is reviewable on an empty database.

## Development

```sh
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css -> public/tailwind.css
npm start
```