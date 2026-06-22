# 🥭 Rajshahi Quiz — WordCamp Rajshahi booth game

A self-hosted, image-friendly **10-question quiz** about Rajshahi (the "Silk City").
Players register with name + email + country, race a per-question timer, and if they
hit the minimum score they **win swag** (pen / cap / t-shirt) with a unique claim code.
Shared live leaderboard + lead capture, same stack as the penalty-shootout booth game.

- Pure **HTML/CSS/JS** front end (no build step; great on phones + a big TV)
- Tiny **Node.js** backend (no dependencies); answers stay server-side (anti-cheat)
- **One game per player** (by email); **swag tiers + inventory + claim codes**
- Staff redemption page at **`/staff.html`**
- **One-command Docker deploy**; data persists on a volume
- Push-to-deploy ready (GitHub Action → GHCR → xCloud)

---

## Run locally

```bash
ADMIN_TOKEN=change-this-token node server.js
# open http://localhost:8090      (the quiz)
# open http://localhost:8090/staff.html   (staff redemption)
```

Requires Node 18+. No `npm install` — standard library only.

## Run with Docker

```bash
docker compose up -d --build
# http://YOUR_SERVER_IP:8090
```

## Deploy on xCloud (push-to-deploy)

Same flow as the penalty game:
1. Create a GitHub repo `rajshahi-quiz`, push this folder.
2. The Action builds & pushes `ghcr.io/<you>/rajshahi-quiz:latest`.
3. Make the GHCR package **public**.
4. In xCloud → Custom Docker → Docker Compose → public URL of `docker-compose.xcloud.yml`.
5. (Optional) Add a repo secret `XCLOUD_DEPLOY_HOOK` with your xCloud push-to-deploy
   URL so every `git push` auto-redeploys.

---

## Editing content (no code)

- **Questions:** `content/questions.json` — `serveCount` controls how many of the pool
  are served (shuffled) per game. Each question:
  `{ id, category, question, image, options[], answerIndex, explanation }`.
  The correct answer is listed at `answerIndex`; the server shuffles options and
  **never sends the answer to the browser**.
- **Images:** drop files in `public/img/` and set a question's `"image": "img/xxx.jpg"`.
- **Swag & timer:** `content/config.json`
  - `perQuestionSeconds`, `showRunningScore`
  - `swag.minToWin`, `swag.tiers` (score thresholds → item), `swag.inventory` (caps).
  - When a tier runs out, the app auto-falls back to the next available item.

## Booth operations

- **Staff page** `/staff.html`: enter the `ADMIN_TOKEN`, see remaining inventory and
  the winners list, and **mark a claim code as redeemed** (prevents double claims).
- **Export leads:** `GET /api/export?token=ADMIN_TOKEN` → CSV
  (`name,email,country,score,total,swag,code,claimed,timestamp`).
- **Reset between days:** `POST /api/reset?token=ADMIN_TOKEN`.

## How it works / anti-cheat

- Questions are sent **without** the correct answer; options are shuffled per session.
- Each answer is locked one at a time via `/api/quiz/answer`, which only then reveals
  that question's correct option — so nobody can read all answers up front.
- Final score is computed **server-side** on `/api/quiz/submit`.
- One score per email (checked at registration and enforced on submit).

## API (reference)

| Method/Path | Purpose |
|---|---|
| `GET /api/config` | quiz name, timer, swag tiers, remaining inventory |
| `GET /api/check?email=` | has this email already played? |
| `POST /api/quiz/start` | `{name,email,country,flag}` → session + shuffled questions (no answers) |
| `POST /api/quiz/answer` | `{sessionId,id,choiceIndex}` → reveals that question's answer |
| `POST /api/quiz/submit` | `{sessionId}` → final score + review + swag + leaderboard |
| `GET /api/leaderboard` | top scores |
| `GET /api/staff?token=` | winners + inventory (admin) |
| `POST /api/claim?token=` | `{code}` → mark swag claimed (admin) |
| `GET /api/export?token=` | CSV of all entries (admin) |
| `POST /api/reset?token=` | clear all results (admin) |

## Files

```
rajshahi-quiz/
├── Dockerfile, docker-compose.yml, docker-compose.xcloud.yml
├── .github/workflows/docker.yml
├── server.js
├── content/
│   ├── questions.json     # editable Q&A pool
│   └── config.json        # timer + swag tiers + inventory
└── public/
    ├── index.html         # the quiz
    ├── staff.html         # staff redemption screen
    └── img/               # question images (add your own)
```
