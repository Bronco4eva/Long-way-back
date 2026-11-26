# Walk reminders

A small Cloudflare Worker that sends "get up and walk" notifications for The Long Way Back.

- Runs at ten to every hour and calls each signed-up phone if it is inside the hours that phone chose and it has not just walked.
- Stores only the phone's push address, time zone, chosen hours and a "walked recently" time. No location, no name, no game progress.
- Makes its own signing keys on first use and keeps them in its storage, so there are no secrets to paste in.

Deploy: connect this repository in Cloudflare under Workers & Pages, with the root directory set to `worker` and the Worker named `long-way-back-push`. Then put the Worker's address into `PUSH_URL` in `index.html`.

Check it locally with `npm install && npm test`.
