# Prompt — remake of a racket-sport scoreboard web app (prototype first)

> Copy everything below the line into the other AI. It contains no secrets,
> no real domains, accounts or keys — only a product/feature description and
> placeholders. The goal is to evaluate how another AI builds it.

---

## Your task

Build the **web frontend** for a racket-sport scoreboard product called **"RallyPoint"** (placeholder name — feel free to keep it).

**Start with a fully working PROTOTYPE: a static front-end with mock/in-memory data only.** No real backend, no database, no authentication, no API keys, no external services. Use hard-coded sample data and fake state so every screen is clickable and looks finished. Only after the prototype looks and feels right should you (optionally, in a later step) propose a backend.

Keep it dependency-light: plain HTML/CSS/JavaScript is preferred (a small framework like Svelte or vanilla + a tiny router is fine). No build step if you can avoid it. Mobile-first, works great on a phone and on a TV/large screen.

## Product in one paragraph

People score racket-sport matches on a smartwatch; the score streams live to this website so friends can follow along, and finished matches are saved to a personal history with stats. The website is the "second screen": a live scoreboard, a list of public live matches to spectate, and a rich match history. For the prototype, simulate the watch by letting the data update on a timer or via simple buttons.

## Supported sports
Padel, Tennis, Pickleball, Badminton, Table tennis, Squash. Each has slightly different rules/labels (sets vs. rally points, tiebreaks, side-out). For the prototype, tennis/padel-style (sets, games, points 0/15/30/40) is enough; just keep the sport configurable in the mock data.

## Screens to build (all with mock data)

1. **Connect / landing**
   - Enter a 4-digit PIN to "connect" to a live match (in the prototype, any PIN loads a sample match).
   - Clean hero, big PIN input boxes, a "Live spectator" link.

2. **Live scoreboard** (the main screen)
   - Two teams ("Us" / "Them" with editable names), big point display (0/15/30/40), games and sets.
   - A small court drawing for the sport with a ball/marker showing who serves and on which side.
   - Player names (singles or doubles) and a clear indicator of **who serves** (show the serving player's name at the start of each game).
   - Badges/toasts for tiebreak, deuce, "change sides", and a short "🎾 <name> to serve" announcement when a new game starts.
   - Optional voice toggle that reads the score aloud using the browser's `speechSynthesis` (no external TTS).
   - A fullscreen button. Multi-language UI (at least English + one other language) via a small in-file dictionary.
   - In the prototype, add dev buttons ("+point us", "+point them", "undo", "new game") to drive the state so the screen feels alive.

3. **Spectator list**
   - A list of "currently live" public matches (mock several), each card showing the owner's name, sport, a "Live" badge and the current games score. Clicking a card opens its live scoreboard.

4. **Match history** (per PIN, private to the owner — but in the prototype just show it)
   - Aggregate view: total matches, win rate, play time, records (longest match, most points, best win streak…), and a few simple charts (matches per week, tempo over time, sport breakdown) — hand-drawn inline SVG/canvas, no chart libraries.
   - Date-range filters (7 / 30 / 90 days / all).
   - A list of match cards. **Each card is clickable and opens its own detail page.**

5. **Match detail page** (one page per match — the highlight)
   Build these graphs from a per-match data object (see model below), drawn with canvas/SVG, no libraries:
   - **Match flow**: a line of the cumulative point difference over the match (above zero = us ahead, below = them ahead).
   - **Who's playing better (2 lines)**: a rolling-window chart with one line per team; the higher line is playing better at that moment; line crossings = momentum shifts.
   - **Points won & lost**: a split bar of total points per team, plus a per-point momentum strip (green/red segments).
   - **Per set**: a small table (games, points, who won).
   - **Shots (experimental)**: a shot-type breakdown (forehand, backhand, volley, smash, service, lob) with counts/percentages and average "power" — clearly labelled *experimental* (it's an estimate). Mock this data.
   - **All stats**: a grid (duration, total points, tempo, streaks, tiebreaks, deuces, side switches).

6. **Account (stub only)**
   - A fake login/profile screen with a language picker. No real auth — just localStorage to remember a name and language. Make clear it's a stub.

## Data model (mock these objects)

Live match state (what the scoreboard renders):
```json
{
  "teamUs": "Us", "teamThem": "Them",
  "sport": 1, "doubles": true,
  "points": [2, 1], "games": [4, 3], "sets": [1, 0],
  "serveTeam": 0, "serveSide": 0, "servePlayer": 0, "serveNo": 1,
  "servePending": false,
  "names": ["Alex", "Sam", "Robin", "Casey"],
  "tiebreak": false, "switchSides": false, "over": false, "winner": -1,
  "lang": "en"
}
```
- `servePlayer` 0–3 maps to `names` (0,1 = Us; 2,3 = Them).
- `servePending` = a server choice is still open → don't announce a server yet.

Saved match (history detail):
```json
{
  "savedAt": 1700000000000,
  "sport": 1, "fmt": 1, "golden": false,
  "sets": [2, 1], "setHistory": [[6,4],[3,6],[6,4]], "winner": 0,
  "teamUs": "Us", "teamThem": "Them",
  "totalPoints": 78, "durationMin": 52, "ptsPerMin": 1.5, "avgPtsGame": 6.2,
  "longestStreak": [5, 4], "tiebreaks": 1, "deuceGames": 3, "sideSwitches": 7,
  "pointsByTeam": [40, 38],
  "pointSeq": [0,0,1,0,1,1,0, "...one entry per point, 0=us 1=them"],
  "setStats": [{"gamesUs":6,"gamesThem":4,"pointsUs":28,"pointsThem":20,"winner":0}],
  "shots": { "forehand": 49, "backhand": 36, "volley_forehand": 4,
             "volley_backhand": 19, "service": 8, "smash": 4, "lob": 11,
             "powerAvg": 8600, "experimental": true }
}
```
- `pointSeq` (real chronological order of who won each point) drives the flow / momentum / "who plays better" charts. Generate a realistic mock sequence.

## Design direction
- Dark, sporty, premium. Deep near-black background, one bright accent (lime/green) for "us", a warm red for "them", amber for highlights.
- Big, confident typography for scores (condensed display font). Rounded cards, subtle borders, soft glow on the accent.
- Smooth small animations (numbers count up, bars grow, gentle ambient background blobs on the coach page). Respect `prefers-reduced-motion`.
- Everything legible on a TV from across the room AND on a phone.

## Hard requirements (because this is a shared/prototype build)
- **No secrets, no real services.** Do not invent API keys, real domains, email providers, analytics IDs or auth tokens. Use obvious placeholders if you reference anything.
- **No real personal data.** Use sample names like Alex/Sam/Robin/Casey.
- Keep it self-contained and runnable by opening an `index.html` (or a tiny static server).
- Comment the mock-data sections clearly so they're easy to swap for a real API later.

## Deliverables for this first round
1. A working static prototype (multiple pages/routes) with mock data and dev buttons to drive the live scoreboard.
2. A short README explaining the file structure and how the mock data maps to a future backend.
3. A list of the charts you implemented and how each is computed from `pointSeq` / `setStats` / `shots`.

Start by outlining the file/route structure, then build the live scoreboard first, then the history + match detail, then the spectator list. Show your work screen by screen.
