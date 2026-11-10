# Changelog

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
