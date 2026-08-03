# Native Android Google sign-in setup

Sporely Android uses `@capgo/capacitor-social-login` to obtain a Google ID
token and sends it to Supabase. Web/PWA login continues to use browser OAuth.

## Required Google Cloud credentials

Create both credentials in the same Google Cloud project:

1. A **Web application** OAuth client. Set its client ID as
   `VITE_GOOGLE_WEB_CLIENT_ID` and configure the same Web client ID and secret
   in Supabase's Google provider.
2. An **Android** OAuth client for every signing certificate that distributes
   the app:

   ```text
   package: com.sporelab.sporely
   SHA-1: exact certificate on the installed APK
   ```

The 2026-08-03 incident was fixed by registering the Google Play app-signing
SHA-1:

```text
61:DB:64:0E:CE:19:EB:4A:83:E2:A0:09:21:24:F2:82:7A:40:B2:1A
```

The value passed as `webClientId` must be the Web credential, not the Android
credential. The Android credential exists in Google Cloud to bind the package
name to a signing SHA-1.

## Signing channels

| Channel | Certificate to register |
| --- | --- |
| Local debug APK | Developer machine's debug keystore SHA-1 |
| GitHub release APK | Certificate embedded in the workflow-built APK |
| Play upload | Upload-key SHA-1 shown in Play Console |
| Play installation | Play app-signing SHA-1 shown in Play Console; this is often different from the upload key |

Observed during the incident investigation:

| Artifact | SHA-1 |
| --- | --- |
| Local debug keystore | `A9:30:44:2B:48:6F:79:81:AC:F2:35:E5:E8:FE:5D:82:23:E2:16:AB` |
| Configured local release keystore | `6C:B3:87:E2:7C:A0:6B:61:EA:E0:E0:4A:B3:A6:27:9D:8C:DF:10:51` |
| Play-installed 0.6.18 | `61:DB:64:0E:CE:19:EB:4A:83:E2:A0:09:21:24:F2:82:7A:40:B2:1A` |

Re-check fingerprints before updating Google Cloud; do not assume the local,
GitHub, upload, and Play keys are identical.

## Inspect certificates

```bash
npm run android:signing-info
npm run android:signing-info -- android/app/build/outputs/apk/debug/app-debug.apk
cd android && ./gradlew signingReport
```

For the app installed on a device:

```bash
adb shell pm path com.sporelab.sporely
adb pull /data/app/.../base.apk /tmp/sporely-installed.apk
npm run android:signing-info -- /tmp/sporely-installed.apk
```

The release workflow prints the certificate embedded in its final signed APK.

## Temporary Capgo 8.3.22 security patch

The pinned plugin version contains two Android log statements that can include
complete cached credentials or a Credential Manager result. The repository's
strict `postinstall` patch replaces those payloads with presence-only messages
and refuses unknown source or package versions. Remove the patch script,
postinstall hook, and exact-version pin when adopting an upstream release that
fixes both log statements.
