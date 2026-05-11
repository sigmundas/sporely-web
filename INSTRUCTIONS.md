# AI Coding Instructions: Sporely Web

## Audit Mindset (STRICT)
- **No praise.** No conversational filler.
- **Categorize problems:** 1. Duplicate logic, 2. Source of truth drift, 3. DB/Schema mismatch, 4. State flow/Race conditions, 5. UI/CSS consistency, 6. Dead code, 7. Bad boundaries, 8. Naming, 9. Edge cases (OOM/Offline), 10. Memory leaks.

## Tech Stack & Constraints
- **Core:** Vanilla JS (ESM), Vite 6, No Frameworks.
- **Mobile:** Capacitor + NativePhotoPicker.
- **State:** Shared mutable object in `src/state.js`.
- **Database:** Supabase JS v2. No raw `fetch`.
- **Media:** Cloudflare R2 via `upload.sporely.no` worker.
- **CSS:** Native properties in `style.css`. No utility classes.

## Critical Patterns
- **Memory:** Canvas work MUST be sequential. Wipe canvas (`width=0`) & revoke URLs immediately.
- **iOS/Safari:** No Blob streaming to `fetch`. Convert to `ArrayBuffer` first.
- **IndexedDB:** Open transactions ONLY after slow async work (Canvas/Encoding) to avoid auto-close.
- **Environment:** Distinguish between PWA (browser limits) and APK (higher ceiling).