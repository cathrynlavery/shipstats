# shipstats

Daily lines-of-code shipped, per project. Runs on GitHub Actions, publishes to GitHub Pages.

## Setup

1. Create a GitHub PAT with `repo` scope at github.com/settings/tokens
2. In this repo's settings → Secrets: add `STATS_PAT` = your PAT
3. In this repo's settings → Variables: add `STATS_USERNAME` = your GitHub username
4. Enable GitHub Pages: Settings → Pages → Source: `gh-pages` branch
5. Trigger the first run: Actions → Generate Ship Stats → Run workflow

Your stats will be live at `https://yourusername.github.io/shipstats/`

## URLs

| URL                      | Shows                     |
| ------------------------ | ------------------------- |
| `/`                      | Today's lines + this week |
| `/daily/2026-05-14.html` | Permanent daily snapshot  |
| `/weekly/2026-W20.html`  | Weekly summary            |

## Private repos

Private repos show as a consistent wacky name (e.g. "Phantom Capybara") — same name every time for the same repo, different name per repo.
