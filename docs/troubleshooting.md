# Troubleshooting

The common ways a copy of VEMI goes wrong, and what to do. Each answer comes from what the app does. If yours is not here, open an issue on the repository and leave out secrets and recovery codes.

## The Deploy button fails

- **Cloudflare asks you to sign in or make an account.** Do that first. A free account is enough, and no card is needed.
- **The build stops at the database step.** The button makes a database and applies its changes as part of the build. Open the build log in the Cloudflare dashboard, under Workers & Pages, then your copy. Try the build again. If it fails the same way twice, copy the last lines of the log into an issue.
- **The build worked but the address shows an error.** Wait a minute and reload. A new Worker can take a moment to answer.
- **You do not see your copy.** Look under Workers & Pages in the same Cloudflare account you used for the button.

## The setup helper stops

- The helper tells you in a sentence what it could not do. The usual cause is the Cloudflare key. Make the key again from the link the helper gives you, with the permissions it names, and paste the new one.
- The helper uses the first Cloudflare account the key can see. Make the key in the account you want the copy in.
- If you close the tab part way, the helper picks up again for an hour. After that, start it again.

## Cannot sign in

- **"cross-origin request refused".** The copy only accepts sign-in from its own address. If you set the variable `ORIGIN`, it must be exactly `https://` plus the address you open, with nothing after it. Open the copy at that address, or change `ORIGIN` to match. See the custom domain steps in [Self-hosting](self-hosting.md).
- **"This copy already has an owner".** Someone has already made the first account. Sign in instead of signing up. If it was not you, and you set `OPERATOR_EMAIL` on your copy, only that address can claim it.
- **Google sign-in does not work.** Without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, the copy says "Google sign-in is not set up here" and only passwords work. If they are set, check that the redirect address in Google is your copy's address plus `/auth/google/callback`. If it worked for a week and then stopped, the Google consent screen is still in testing. Publish it In production.
- **You forgot your password.** On the sign-in screen, choose Use a recovery code. The recovery code is the one VEMI showed you once, when you made the account. If you were invited, ask the owner for a Reset link. The owner makes one under People in Account.
- **An invite link does not work.** Invite links last 7 days. Ask the owner for a new one.
- **Everyone was signed out.** Changing `SESSION_SECRET` signs every device out. Sign in again.
- **Locked notes will not open.** Use a passkey, the vault password or the recovery key. See [Privacy](privacy.md).

## Everything stopped working for the day

On the free plan, Cloudflare allows 100,000 requests a day for the whole account. Past that, requests fail until midnight UTC. Other Workers in the same account share it. See the table in [Self-hosting](self-hosting.md).

## An update is stuck

- **There is no Update button, only How to update.** A copy made with the Deploy button holds no key, so it cannot update itself. Follow [Updating](updating.md).
- **No update is offered.** The copy checks once a day, and only offers a release that is signed and newer than the one it runs. A copy built before the first signed release offers nothing.
- **A step stopped.** The list shows the sentence it stopped with. Press Try again, which carries on from that step. If you close the tab, open it again and the update carries on.
- **"This update could not be checked, so it was not installed".** The release did not match its signature. Nothing was changed. The copy tries again the next day.
- **"This copy kept no key to update itself with".** Update myself was turned off. Run the setup helper again to update.
- **Go back is refused.** It lasts 7 days, works once, and may refuse if you changed a secret since the update. Your data is not undone by Go back. See [Updating](updating.md).

## Reminders do not arrive

- Reminders are set per device. Turn them on in Account, under Reminders, on each device.
- Check Quiet hours. Nothing comes through inside them.
- If the browser blocked them, allow them in its site settings and use Send a test.
- On an iPhone, VEMI must be on the home screen, and iOS 16.4 or later. See [Reminders](reminders.md).
- In Try it now mode, reminders show only while the page is open.

## Your work has gone

- In Try it now mode, data lives in one browser. Clearing site data deletes it, and only an export file brings it back. See [Try it](try-it.md).
- On a copy, restore an export file, or rewind the database with Time Travel within 7 days. See [Backups](backups.md).
