# Russian Windows distribution

This is a GUI-only derivative of the official omp release, maintained in `AG-albino/oh-my-pi-gui` on `ru-distribution`. The upstream contribution is PR https://github.com/nornzach/oh-my-pi-gui/pull/16; derivative update configuration is intentionally excluded from that PR.

## Update guarantees and limits

Windows packages use the existing omp application identity/profile and NSIS installation layout, preserving sessions, credentials, settings and the explicit language preference. Their updater reads only this fork's `ru` channel (`ru.yml`), allows `-ru.N` releases and rejects downgrades. An original upstream release cannot overwrite the Russian build through this feed.

New upstream changes are proposed by the daily `Sync upstream into Russian distribution` workflow. It opens at most one pending PR and never merges or publishes automatically. New English keys fail locale parity tests; schema coverage is checked against the actual pinned Core before release. Conflicts, changed settings or new UI text require review. Keeping the previous translated version until the next reviewed release is intentional; this is not a promise that arbitrary future upstream versions can be translated without maintenance.

## Core provenance

The initial derivative reuses the unmodified Windows Core from the official v0.9.22 installer. `ru-sidecar-source.json` pins the official installer SHA-256, extracted sidecar SHA-256 and recorded agent-source commit. `scripts/prepare-ru-sidecar.ps1` validates both hashes before copying the sidecar to the ignored `resources/omp.exe`. No runtime agent changes are made. This follows the upstream README's supported standalone GUI build using a trusted compatible prebuilt sidecar. The original all-platform maintainer release runbook does not apply to this Windows-only derivative.

## Releasing

1. Review/merge upstream updates into `ru-distribution`; retain all localization and fork updater changes. Update the official Core release/hash pins when changing the bundled runtime.
2. Complete new translations and terminology review; update the version to `<upstream-version>-ru.<revision>` in package.json. Never reuse a published tag/version. Do not merge the upstream PR branch with derivative configuration back into the official project.
3. Run full Linux tests, type checks, build and Biome on touched files. On Windows, install locked dependencies, run `./scripts/prepare-ru-sidecar.ps1`, validate `bun scripts/check-russian-schema.ts resources/omp.exe`, build with `bun run package:win -- --publish never`, and run `node scripts/smoke-russian-gui.ts dist/win-unpacked/omp.exe` (Node 24; Bun's Windows Playwright process transport is not suitable for this harness).
4. Check `en-US.pak` and `ru.pak` exist, `app-update.yml` names owner AG-albino/channel ru, `ru.yml` contains the expected version and setup SHA-512, and the sidecar hash matches its pin.
5. Commit and tag a clean checkout (`v<package-version>`), push to this fork, then dispatch `Release Russian Windows build` with that tag and `publish=true`. It reruns full Linux validation, builds on Windows, smoke-tests the packaged app, records hashes and only then publishes.
6. Verify setup, portable, setup blockmap, ru.yml and SHA256SUMS.txt are present in the release; check the real updater can read the channel. Linux/macOS are not currently released by this derivative.

Unsigned Windows packages inherit upstream's signing status. Version prerelease syntax is used to isolate the custom `ru` channel. Installing a later reviewed RU setup over the existing omp installation retains the existing profile. Do not delete application data during uninstall/reinstall.
