# Updating

How a copy of VEMI gets a new version, and how to go back. Only the owner of a copy can update it.

## A copy made by the setup helper

In Account, under About, the Version rows show Update available with the release's notes when a newer version is out. The copy checks once a day for one with a plain request that carries no cookie and nothing that names your copy.

1. Press Update. One tap is all it takes.
2. The list ticks through Restore point, App files, Data layout and New version.
3. The page reloads on the new version and the row reads Updated to that version.

If a step stops, the list shows the sentence it stopped with and a Try again row. Try again carries on from the step that stopped. If you close the tab part way, the update carries on from the stored step when you open it again.

An update never starts without that tap. The copy only looks for a new version by itself. It installs nothing until you press Update.

### Updates are refused unless signed

Every release is signed by Anvil Dynamics. Your copy holds the public half of the signing key and checks the signature before it installs anything. A release with no signature, or a signature that does not match, is refused. So is a release that is not newer than the one you are running, even with a good signature. Each signed release also carries the date it was issued. Your copy remembers the newest date it has accepted and refuses an older one, so an old copy of the release feed played back to you cannot stop you hearing about a newer release. A date more than a day ahead of your copy's clock is refused too. [Releasing](releasing.md) says how releases are signed.

### Update myself

Update myself reads On while your copy holds the key the setup helper gave it. Turn off removes that key from the copy and shows a link to remove the token in Cloudflare. Type off to confirm. It cannot be turned on again from VEMI. To update after that, run the setup helper again.

### Go back

For 7 days after an update, About shows Go back to the version you had, with the day it lasts to. Press Go back and the copy runs the old version again, and the row reads Back on that version. After 7 days, or after one Go back, the row goes. Go back may also refuse if you changed a secret on the copy since the update.

Go back changes the app, not your data. Data changes are not undone. An update can add to the database, and the old version then runs on the new layout. This is safe because each update's changes are additive for one release: they add tables and columns and take nothing away, so the old version still finds what it needs. To put the data itself back, use the restore point below.

## A copy made with the Deploy button

A copy made with the Deploy button holds no key, so it cannot update itself. About still shows Update available and the notes, and a How to update link to this page in place of the Update button.

Cloudflare made a repository for the copy when you pressed the button. To update, sync that repository with the public VEMI repository, by pulling the public repository's main branch into it. Pushing that change starts the next build. Cloudflare builds and deploys it, applying the new database changes. Your data stays in your copy's database.

## Restore data from the restore point

An update that changed the database also takes a restore point first: a Time Travel bookmark of the database from just before the update. Cloudflare keeps Time Travel for 7 days on the free plan, the same as Go back. While Go back is on offer, About shows the Restore point row with the bookmark, the note that data changes are not undone, and a Restore data link to this page.

Restoring puts the whole database back to that moment, for everyone on the copy. Everything written since is lost. It is not a button in VEMI, because it cannot be undone. Run it yourself, from the folder of your copy's repository, signed in to Cloudflare:

```
npx wrangler d1 time-travel restore <database name> --bookmark=<the restore point>
```

The database name is the one shown for the copy under D1 in the Cloudflare dashboard. If you want the app back on the old version too, press Go back first. The restore point and the old version belong together.
