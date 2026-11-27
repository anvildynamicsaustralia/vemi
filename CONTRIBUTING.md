# Contributing

## Issues only, for now

Issues are welcome. Pull requests are not accepted yet. Please keep to the [code of conduct](CODE_OF_CONDUCT.md).

## File a bug

Open an issue with the bug form and say:

- What you did.
- What you expected.
- What happened.
- Your browser and device.

Leave out secrets. Never paste a recovery code.

## File an idea

Open an issue with the idea form. Say what you want to do and what gets in the way today.

## Run the checks

You need Node 22, pnpm and bash.

```
pnpm install --frozen-lockfile
scripts/check.sh
```

It must end with `ALL CHECKS PASSED`.

## Run it on your machine

You need Node 22 and pnpm.

```
pnpm install --frozen-lockfile
pnpm run build
pnpm run dev
```

`pnpm run dev` applies the database changes to a local database and starts the Worker on `http://localhost:8787`. It needs no keys: without them, sign-in is passwords only. To give it keys, either:

- copy `.dev.vars.example` to `.dev.vars` and fill it in, or
- set the same names in the environment the command runs in. When any of them is set there, the environment is used and `.dev.vars` is not read.

The maintainers keep the keys in Infisical. `.infisical.json` names the project and picks its `dev` environment, and holds no secret. With the Infisical CLI signed in (`infisical login`), run:

```
infisical run -- pnpm run dev
```

For the staging keys, run `infisical run --env=staging -- pnpm run dev`. The command prints which names it found, never a value.

For the page with live reload, run `pnpm run dev:web` beside it and set `ORIGIN=http://localhost:5173` (in `.dev.vars` or the vault) so sign-in accepts that page.
