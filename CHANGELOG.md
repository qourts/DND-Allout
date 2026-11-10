# Changelog

## Official teams and rosters (November 10, 2026)
- The 32 official team names, bracket assignments and registered player rosters from the 2026-11-10 registration sheet now replace the fictional demo teams.
- Team pages show each team's registration status and Team Captain, if one is marked in the sheet. The "Fictional demo team" labels are removed.
- Registration reference numbers are left out of this public page on purpose. Only player names, their side (women's or men's) and the captain mark are included. There are no contact details and no DUPR IDs.
- Match results and notices are still demo data. The demo banner now says so.

## Rules update: serve to win (November 10, 2026)
- Confirmed rule: the winning point must be scored by the serving team. If the receiving team wins a rally at game point, they gain the serve but cannot win the game on that rally.
- Updated in the Help answer "How is each game scored?" (now includes the 20–18 example), in the Scoring chapter of ALL-OUT Explained and on the Rules page. The "Awaiting DND" flags for this rule are removed.
- The pending-clarifications notice in Updates now lists only the Dreambreaker timeout rule.

## Home page update — November 10, 2026

All changes are in `index.html`. It is still a single standalone file: every image and script is embedded, and nothing is loaded from the network. It doesn't connect to Supabase and has no live score sync.

### Hero
- New hero styled like the registration site. It has the date and venue line, the ALL-OUT logo, and the line "4 players. One team. Go all-out."
- A live countdown runs to first serve (9:00 AM Philippines time, November 14). In the matchday demo scenarios it shows the day's status instead.
- **Find my team** jumps to the team search. Once a team is chosen, the button opens that team instead. There is also a **Schedule** button.
- A fanned deck shows the four official posters: medals, tournament jersey, merch shirt and raffle prizes.
  - Swipe the deck, or tap a card behind the front one, to change poster. Chips below the deck do the same, and on a computer the arrow keys work too.
  - Tap the front card to open the full-size poster.
  - The deck changes poster on its own until someone uses it. It stays still for people who turn off animations.
- A sponsor logo strip scrolls across the bottom of the hero. It holds all 31 partner and sponsor logos. It pauses on hover, and tapping it jumps to the Partners & sponsors section.

### Rest of Home
- The team search comes first on the page, or your team card once a team is chosen. After it come the Matchday desk with real upcoming or live matches, then Latest updates.
- **ALL-OUT Explained** is a page-turning book with the six official chapters. It uses StPageFlip v2.0.7 (MIT licence), embedded in the file.
- Quick answers link to the Help & FAQ page.
- **Partners & sponsors** matches the registration site's wall, with the real logos for each tier and the official event partners.

### Tested
- Chromium at 320, 390, 768 and 1440 px wide, across all the demo scenarios. No page overflow, no text below 13px and no console errors.
- Checked: swiping the deck, tapping and opening the posters, keyboard arrows, page turning in the book, and the reduced-motion settings.
- Not yet tested on real phones.
