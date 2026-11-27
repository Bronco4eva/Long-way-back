# Walk reminders

A small Cloudflare Worker that sends "get up and walk" notifications for The Long Way Back.

- Runs at ten to every hour and calls each signed-up phone if it is inside the hours that phone chose and it has not just walked.
- Stores only the phone's push address, time zone, chosen hours and a "walked recently" time. No location, no name, no game progress.
- Makes its own signing keys on first use and keeps them in its storage, so there are no secrets to paste in.

Deploy: connect this repository in Cloudflare under Workers & Pages, with the root directory set to `worker` and the Worker named `long-way-back-push`. Then put the Worker's address into `PUSH_URL` in `index.html`.

Check it locally with `npm install && npm test`.

## Villager voices for everyone

`POST /talk` lets players without their own key talk to the villagers. Add the key once as a secret named `ANTHROPIC_API_KEY` on the Worker (Settings, Variables and Secrets). It is never sent to a phone.

- Limits: 40 replies a day per player and 400 calls a day in total. Change them with the plain variables `TALK_PER_PLAYER` and `TALK_EVERYONE`. `TALK_MODEL` picks the model (default `claude-opus-5-5`).
- Each copy of the game makes its own random player code and sends it with every call. The server keeps one record a month against a scrambled form of that code: today's counts, the month's counts and the month's story tokens. It stores none of the words. A page from before player codes is counted against a scrambled internet address instead.
- Requests ask Anthropic to hand a declined request to a fallback model (`fallbacks: "default"`), and retry without that option if it is not accepted.
- Set a monthly spend limit in the Claude Console as the real backstop.

## The story that adapts to each player

`POST /story` is the same relay with two differences: it has its own daily count (12 a day per player, `STORY_PER_PLAYER`), and the server fixes the shape of the answer, so a story turn can only ever be a scene, a line, a thread and at most one favour. The game writes the request from the player's save and checks every part of the answer before it touches the save. `kind` is `turn` (one small turn of the story, once a day) or `recall` (rewriting the few lines a villager remembers of the player after a talk).

`POST /usage` with the player code returns the plan, today's counts, the limits and the month's totals. The game shows them on the phone screen.

Plans, for a later subscription: `PLANS` in `src/index.js` holds what each plan allows in a day (`free` 40 replies and 12 story calls, `paid` 200 and 40). A player is on `paid` when storage holds the line `plan:<scrambled code>` = `paid`. Nothing writes that line yet; a payment page would. There are no accounts and no payments in this code.

## Steps from the Health app

A shortcut on the player's iPhone calls `GET /steps/<code>?hours=9-320_10-45` with today's step count for each hour. The game makes the code (`POST /steps-on`), reads the counts back (`POST /steps-read`) and can remove them (`POST /steps-off`).

- Stores only the hourly counts for the day and when they arrived, under a scrambled form of the code. No location and nothing else from Health.
- A code the game never registered is refused, so nobody else can fill the storage.
- An unchanged count is not written again, to stay inside the free plan's daily write limit.
- If the phone also takes Tobiah's calls, he skips an hour in which the phone has already reported 250 steps.
