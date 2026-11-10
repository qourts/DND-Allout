# DND ALL-OUT Pickleball League — Player Portal

Standalone, mobile-first player portal for the November 14, 2026 event at Kingcourts Pickleball, San Fernando, Pampanga.

## Run the portal
Open [index.html](index.html) locally in a modern browser. All required presentation assets are embedded in the HTML.

## Current status
- This is the **standalone player-portal baseline** committed from the supplied `AllOut-Player-Portal.html`.
- Tournament schedule, brackets, guide and interface are bundled in the page.
- **Any fictional/demo team names, rosters, or results are not official tournament data.**
- This version does **not** use Supabase or live score synchronization.

## Publish on GitHub Pages
In this repository, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, select **main** and **/(root)**, then save.

Once GitHub reports a successful publication, the expected Pages URL format is:
`https://qourts.github.io/DND-Allout/`

Do not treat a successfully published static page as a validated live scoring system. Verify the page in a browser before sharing the link.

## Next steps
Review the online static portal, then separately implement and test real-time data integration and scoring before enabling live results.
