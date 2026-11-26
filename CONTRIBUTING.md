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
