# Arun's Daily AI Dev Digest

Static site generated from Hermes cron job output.

- **Source:** Daily AI Dev Productivity Substack Digest cron job (9am IST daily)
- **Days:** 83
- **Posts:** 616
- **Date range:** 2026-04-27 → 2026-08-02

## Build

```bash
python3 build_daily_briefs_site.py   # parses cron outputs → data.json
python3 render_daily_briefs_site.py  # renders data.json → index.html
```

## Deploy

Push `index.html` to a GitHub repo with GitHub Pages enabled (Settings → Pages → main branch / root).
