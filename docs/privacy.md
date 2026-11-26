Last checked against the code: 22 November 2026.

# Privacy

What VEMI stores, where it sits and who could read it. There are three ways in, and the answer is different for each.

## Local mode

Try it now opens VEMI with no account. Everything you make is kept in this browser, on this device. It never leaves the device, and nothing is sent to anyone. There is no server holding it, so nobody else can read it, and clearing this browser's site data removes it.

Moving to your own cloud is the one time local data travels. It goes from the browser straight to the new copy, to an address you gave it, and nowhere else. The hand-over that move makes lasts 5 minutes and opens once. After the move, Clear this device empties the browser's copy. [Try it](try-it.md) has the steps.

## A copy of your own

Get my own VEMI, or the Deploy button, makes a copy in your own Cloudflare account. Your data is kept in that copy's database in your Cloudflare space. VEMI does not run a server that holds it, and the people who make VEMI see none of it.

Whoever runs a copy runs the Cloudflare space that holds it. On your own copy that is you.

## Someone else's copy you were invited to

Your data is kept in the database of the copy you were invited to. Each account is one person, and the owner of a copy invites others. Nobody sees anyone else's data in VEMI.

Whoever runs a copy runs the Cloudflare space that holds it. So the data you have not locked sits in the owner's Cloudflare space, and the owner could technically read it there. Locked notes and full account encryption stop that. If you want the owner to be unable to read something, lock it or turn full account encryption on.

An invite link lasts 7 days. If you ask to go, Delete my account removes you after 7 days, and you can cancel until then.

## What Cloudflare does

Cloudflare encrypts data at rest and in transit. Whoever runs a copy chooses nothing about that, and VEMI adds nothing to it. It is the protection against someone outside reading the stored data or the traffic. It does not stop the person who runs the Cloudflare space, which is what the next two sections are for.

## Locked notes, App lock and full account encryption

In Account, under Privacy and security, you can lock the text of a project's brief and description, a task's description and a note. The text is sealed on your device, with a key that never leaves your devices in a form the server can use. The server holds only the sealed text, so neither the owner of the copy nor anyone who reads the database can open it.

The key can be opened with Face ID or fingerprint, a vault password, or the recovery key. A second device opens locked things with a link from one that already can, or with the recovery key. The Locked marker shows where something is sealed and the device has no key open.

App lock covers VEMI on this device after the time you choose. Opening it again needs a connection and your Face ID or fingerprint. It is a setting of this browser, not of your account.

Full account encryption goes further. Under Privacy and security, press Turn on and every typed field, such as names, titles, bodies, checklists and tags, is sealed on your device. The server then holds those fields only as sealed text. What stays readable to the server is the structure, dates and reminder times: which things are inside which, when they are due, when a reminder is set to go, and counts. The account's first name and the labels of your devices stay readable too.

What the screen says when you turn it on is what happens:

- Search runs on your devices.
- Reminders show titles only on your devices. A reminder still shows the task's title, because your device opens it when the reminder arrives.
- The AI connector can't read this account.
- If you lose every device and your recovery key, nobody can get your data back.

That last line is the whole story of a lost key. A device that is already open can still read, and the recovery key opens a new one. If every device and the recovery key are gone, neither the owner of the copy nor anyone who makes VEMI can help.

## The setup key

Get my own VEMI asks for a Cloudflare key you make from a link it gives you. The key is named VEMI setup. It can make your database, put VEMI in your Cloudflare account and give it an address. Its permissions are Workers Scripts Edit, D1 Edit and Account Settings Read, and they are not limited to VEMI. Other Workers and databases in the same Cloudflare account are within its reach.

Cloudflare's API accepts no call from a browser on another address, so the setup page sends each call through the VEMI front door, a small relay. The setup key passes through the front door only if the relay is used, and there it is never stored or logged. It goes on to Cloudflare in one header and is not sent back.

You choose whether your copy keeps the key to update itself. With Let my copy update itself on, the copy keeps it encrypted in its own database, and uses it only when you press Update. With it off, the key is not given to the copy at all. The setup page shows a link to your keys on Cloudflare, so you can delete the one named VEMI setup yourself. It does not delete the key for you, and it says so.

## Updates and releases

Every release is signed. Your copy holds the public half of the signing key and checks the signature before it installs anything, so a release with no signature or a wrong one is refused: unsigned releases are refused, and a copy keeps running the version it has. The check once a day for a new version is a plain request that carries no cookie and nothing that names your copy. [Updating](updating.md) and [Releasing](releasing.md) have the rest.

Go back keeps the old version on offer for 7 days after an update. It changes the app and leaves your data as it is.

## No email, no model

VEMI sends no email, so there is no address list and no message to intercept. Reminders are push and in the app.

VEMI calls no model. The connector lets your own Claude or ChatGPT in, and that is a choice you make. [Connect your AI](connect-your-ai.md) has the steps.

## For the reader of the repo

This page was written from the code and has not been through a lawyer.
