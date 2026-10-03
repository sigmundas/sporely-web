# Enable R8 for Android release builds

Status: proposed 2026-10-03. Not implemented.

## Problem

Google Play Console flags release 290 (0.7.13): "DEX code optimization is below
our threshold — Obfuscation (1%)". Percentages under 25% in any category may
affect visibility and publishing on Google Play. Fix by **Feb 2027**.

Cause: `android/app/build.gradle` release build type has `minifyEnabled false`,
so R8 never shrinks, optimizes or obfuscates the DEX.

## Change

In `android/app/build.gradle`:

```gradle
release {
    minifyEnabled true
    shrinkResources true
    proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    signingConfig = signingConfigs.release
}
```

## Keep rules already in place

- `@capacitor/android` ships consumer rules that keep `@CapacitorPlugin`
  classes, `Plugin` subclasses and `@PluginMethod` / `@PermissionCallback` /
  `@ActivityCallback` methods. This covers the app's own plugins
  (`NativeCamera`, `LocationSettings`, `NativePhotoPicker`,
  `UploadSyncService`) and the npm Capacitor plugins.
- `@capgo/capacitor-social-login` ships `consumer-proguard-rules.pro`.

Add rules to `android/app/proguard-rules.pro` only for a concrete failure seen
in a release build. Do not add broad `-keep class **` rules; they defeat the
obfuscation score.

## Risk areas

Code reached by reflection or by name:

- Google / Apple sign-in (social login)
- Background upload sync service and its plugin
- Native camera and photo picker
- File picker, filesystem, share
- Any Java object serialized to JSON via reflection

## Verification

1. `npm run android:build:release` succeeds.
2. Install the release build on a device and exercise: sign-in (Google and
   Apple), camera capture, photo picker, upload sync including background
   sync, file picker and share, offline/network transitions.
3. Confirm `android/app/build/outputs/mapping/release/mapping.txt` exists and
   is included in the uploaded AAB (or upload it in Play Console) so crash
   stack traces stay readable.
4. After upload, check that the Play Console release dashboard shows
   obfuscation above 25%.
