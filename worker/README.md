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
