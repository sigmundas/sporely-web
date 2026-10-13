# Inbox

- Add a tooltip to the species badge explaining what it means.
- "What's new" after an update: the first time the app opens on a new
  version, show a very short list (2–4 bullets) of what changed, in plain,
  non-technical language (e.g. "You can now compare two finds side by
  side"). Dismiss once; remember the last version seen locally. Needs
  translated text for no/sv/en/de per release. Skip it on a fresh install.
- "Update available" prompt with a link to Google Play when the installed
  app is older than the live one. Play review takes 1–5 days, so don't
  compare against our own latest build number. Ask Play what's actually
  live, using the Play In-App Updates API (e.g. the
  `@capawesome/capacitor-app-update` plugin: `getAppUpdateInfo()` →
  `updateAvailability`, then `openAppStore()` or a flexible in-app update).
  Only works for Play installs; sideloaded/Obtanium/GitHub APKs need a
  separate check or no prompt. Don't nag: show at most once per version.
