# AGENTS.md

- This repository is a Pi extension.
- The pi source code lives under `~/src/pi`; the Obscura source code lives under
  `~/src/obscura`. Feel free to consult them if needed.
- Before running any `npm` command, run `source ~/.nvm/nvm.sh && nvm use` to
  load the correct Node.js version.
- Verify changes by running `npm run typecheck` and `npm run lint`.
- Make sure code is formatted with `npm run format`.
- When `npm audit` identifies a fix blocked by `min-release-age`, do not modify
  `package.json`. Do not attempt `--before` overrides or `min-release-age=0`
  workarounds. Report the vulnerability, the fixed version, and the date the fix
  becomes installable (publish date + cooldown period). Never override the
  `before` configuration or the `min-release-age` setting. The package cooldown
  is a deliberate supply-chain security policy.
