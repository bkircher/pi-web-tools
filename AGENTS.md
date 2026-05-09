# AGENTS.md

- This repository is a pi extension.
- Before running any `npm` command, run `source ~/.nvm/nvm.sh && nvm use` to
  load the correct Node.js version.
- Verify changes by running `npm run typecheck` and `npm run lint`.
- Make sure code is formatted with `npm run format`.
- When `npm audit` identifies a fix blocked by `min-release-age`, do not modify
  package.json. Do not attempt `--before` overrides or `min-release-age=0`
  workarounds. Report the vulnerability, fix version, and the date it becomes
  installable (publish date + cooldown period). Never override the `before`
  config or `min-release-age` setting. Package cooldown is a deliberate
  supply-chain security policy.
