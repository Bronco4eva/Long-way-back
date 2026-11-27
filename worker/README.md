# Walk reminders

A small Cloudflare Worker that sends "get up and walk" notifications for The Long Way Back.

- Runs at ten to every hour and calls each signed-up phone if it is inside the hours that phone chose and it has not just walked.
- Stores only the phone's push address, time zone, chosen hours and a "walked recently" time. No location, no name, no game progress.
- Makes its own signing keys on first use and keeps them in its storage, so there are no secrets to paste in.

Deploy: connect this repository in Cloudflare under Workers & Pages, with the root directory set to `worker` and the Worker named `long-way-back-push`. Then put the Worker's address into `PUSH_URL` in `index.html`.

Check it locally with `npm install && npm test`.

## Villager voices for everyone

`POST /talk` lets players without their own key talk to the villagers. Add the key once as a secret named `ANTHROPIC_API_KEY` on the Worker (Settings, Variables and Secrets). It is never sent to a phone.

- Limits: 40 replies a day per player and 400 a day in total. Change them with the plain variables `TALK_PER_PLAYER` and `TALK_EVERYONE`. `TALK_MODEL` picks the model (default `claude-opus-5-5`).
- The server keeps a daily count against a scrambled internet address and stores none of the words.
- Requests ask Anthropic to hand a declined request to a fallback model (`fallbacks: "default"`), and retry without that option if it is not accepted.
- Set a monthly spend limit in the Claude Console as the real backstop.

## Steps from the Health app

A shortcut on the player's iPhone calls `GET /steps/<code>?hours=9-320_10-45` with today's step count for each hour. The game makes the code (`POST /steps-on`), reads the counts back (`POST /steps-read`) and can remove them (`POST /steps-off`).

- Stores only the hourly counts for the day and when they arrived, under a scrambled form of the code. No location and nothing else from Health.
- A code the game never registered is refused, so nobody else can fill the storage.
- An unchanged count is not written again, to stay inside the free plan's daily write limit.
- If the phone also takes Tobiah's calls, he skips an hour in which the phone has already reported 250 steps.
