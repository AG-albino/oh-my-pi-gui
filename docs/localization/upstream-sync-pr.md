The official GUI has new commits. This PR brings them into the maintained Russian distribution without publishing an untranslated release.

Before merging/releasing:
- Resolve conflicts while retaining Russian dictionaries, language integration and the fork's ru updater channel.
- Review new English UI/schema strings and update the Russian translation under docs/localization/ru.md.
- Update ru-sidecar-source.json to the intended official Core release and verified installer/sidecar hashes when the runtime changes.
- Set a new `<upstream-version>-ru.<revision>` package version; never reuse a published version.
- Require full CI, schema coverage and packaged Windows smoke verification before release.

No automatic merge or release is performed by the synchronization workflow.
