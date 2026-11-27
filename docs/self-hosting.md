# Self-hosting

Your own copy of VEMI runs in your own Cloudflare account, on the free plan, with its own database. It costs nothing. Nobody else holds your data.

## Two ways to make a copy

### The setup helper

Get my own VEMI on the VEMI page opens the setup helper. It asks for a Cloudflare key you make from a link it gives you, builds the copy with that key, and hands you over to it. The key is sealed inside the copy so it can update itself later (see [Updating](updating.md)). You can remove it at any time from Account, under About, with Turn off, then delete the key named VEMI setup in Cloudflare.

The helper can also move your data in from local mode or from an old account. See [Try it](try-it.md).

### The Deploy button

For people who work with code. This button makes a copy in your Cloudflare account from the public repository:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anvildynamicsaustralia/vemi)

Follow Cloudflare's steps. It makes a Worker and a database in your account, applies the database changes and gives the copy an address ending in `workers.dev`. No secret is typed anywhere.

Open that address and make the first account. The first account owns the copy. After that it is invite only: the owner invites each person from the app and passes the link on, because VEMI sends no email. A copy made this way holds no key to update itself. See [Updating](updating.md).

## Google sign-in

Optional. Without it, people sign in with an email and a password. To add Continue with Google:

1. In the Google Cloud console, make an OAuth client of type Web application.
2. Add your copy's address plus `/auth/google/callback` as an authorised redirect URI.
3. Publish the consent screen In production, with only the scopes `openid email`. Left in testing, Google signs everyone out after seven days.
4. Give the copy the two keys. They are named in the file `.dev.vars.example` in the repository:

| Name | What it is |
|---|---|
| `GOOGLE_CLIENT_ID` | The client id from Google. |
| `GOOGLE_CLIENT_SECRET` | The client secret from the same place. |

In Cloudflare, add `GOOGLE_CLIENT_ID` as a variable and `GOOGLE_CLIENT_SECRET` as a secret on your Worker. To run a copy on your own machine, copy `.dev.vars.example` to `.dev.vars` and fill them in there. Setting the same names in the environment `pnpm run dev` runs in works too, and is used ahead of `.dev.vars`. Leave both empty for passwords only. Never paste a secret into a chat, an issue or a page.

Three more names in `.dev.vars.example` are optional, and a copy starts without them:

| Name | What it does |
|---|---|
| `SESSION_SECRET` | Replaces the key the copy makes for itself on first start, if you want your own. |
| `VAPID_PUBLIC` | Replaces the generated push public key. Set it with `VAPID_PRIVATE`. |
| `VAPID_PRIVATE` | Replaces the generated push private key. Set it with `VAPID_PUBLIC`. |

## Who can claim a copy

Whoever reaches a new copy first and makes an account owns it. To stop anyone else getting there first, add a secret named `OPERATOR_EMAIL` on your Worker with your email address. Then only that address can make the owner account. It is not a way back in on its own. Setting it is optional.

## A custom domain

A copy works on its `workers.dev` address. To use your own name, the domain must already be on Cloudflare, which is free.

1. In the Cloudflare dashboard, open your Worker, then Settings, then Domains & Routes, and add a custom domain. Cloudflare makes the DNS record and the certificate.
2. Set the variable `ORIGIN` to the exact new address, `https://` plus the domain, with nothing after it. Sign-in only accepts the address in `ORIGIN`.
3. If you use Google sign-in, add the new callback to the Google client first, as above.

## Turning the landing page off

A copy shows a landing page to anyone who is signed out. To show the sign-in instead, the owner opens Account, then About, and under Front page presses Off. On brings it back.

## What the free plan limits

Checked against Cloudflare's documentation on 14 Nov 2026. Limits change, so check them again at [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/) before you rely on one.

| Piece | Free plan allowance |
|---|---|
| Workers requests | 100,000 a day per account, reset at midnight UTC. Past it, requests fail until the reset. |
| Workers CPU | 10 ms per request. |
| Cron triggers | 5 per account. VEMI uses 1, every minute. |
| Subrequests | 50 per request. |
| D1 database | 5 million rows read and 100,000 rows written a day, 5 GB in all. |
| D1 Time Travel | 7 days. |
| Custom domain | Free on a domain already on Cloudflare. |

The limits are per Cloudflare account, so other Workers in the same account share the daily requests. A copy for one person and a few invitees is far under them.

Measured numbers are added after production use.

## Remove a copy

Export first: Account, then Your data, then Export everything. See [Backups](backups.md).

1. In the Cloudflare dashboard, delete the Worker.
2. Delete the D1 database with the same name. This removes the data for good.
3. Delete the key named VEMI setup under your API tokens, if the setup helper made the copy.
4. If you made the copy with the Deploy button, delete the repository Cloudflare made, if you no longer want it.
