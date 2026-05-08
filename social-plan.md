
By making **Drafts Public by default**, you allow the community to see the "Live Stream" of science happening.
* **The UI:** In the feed, a "Draft" has a subtle **"Draft"** badge.
* **The Logic:** It doesn't appear in the "Featured" or "Verified" lists, but it *is* on the map.
* **The Benefit:** If someone sees a public draft of a rare species, they can "Follow" it to get notified when you finally upload the spore measurements or a final ID.

If a user wants to work on a find in total secrecy (e.g., they found a massive Porcini patch and don't want anyone seeing the exact pin until the season is over), they toggle it to **Private**.
* **Cost:** This consumes **1 Privacy Slot**.
* **Slot Count:** I think **20 slots** is the "sweet spot." Ten feels a bit stingy if someone is doing a heavy microscopy weekend. Twenty allows for a full "Foray" to be kept private while they process the data.


This is a significant refinement. We are moving from a "Safety First" (hidden by default) model to an **"Open Science First"** (transparent by default) model. This is much better for data density and user growth.

Below is the tidied **Phase 7 Plan**, reconciled with your existing SQL and the new UI requirements.

---

# Phase 7: Transparency, Social Trails, and Privacy Slots

## 1. The Core Logic & Database Changes
We need to update the Supabase schema to support the "Draft" state and the "Privacy Slot" accounting.

### Schema Updates
* **`is_draft` (boolean, default: true):** New column. Observations are Draft until "Finished." Public by default.
* **`location_precision` (text, default: 'exact'):** New column (`'exact'` or `'fuzzed'`).
* **`visibility` (text, default: 'public'):** Values: `'public'`, `'friends'`, `'private'`. (Note: We use `'private'` instead of the legacy `'draft'` visibility level to avoid confusion with the `is_draft` status).

### The "Privacy Slot" Engine (Trigger Update)
A "Privacy Slot" is consumed if an observation is **not** fully transparent.
> **Logic:** `(visibility != 'public') OR (location_precision != 'fuzzed')`
* **Free Tier Limit:** 20 slots.
* **Pro Tier:** Unlimited.

### Updated Feed Logic (Views)
* **`observations_community_view`:** * Return **Exact GPS** by default.
    * Only `ROUND()` coordinates if `location_precision = 'fuzzed'`.
    * Hide completely if `visibility = 'private'`.
* **`observations_follow_view` (New):**
    * Joins the `follows` table. 
    * Shows updates for followed **Users**, **Species**, or **Genera**.

---

## 2. UI Refinements (Mobile/Web)

### Find-Detail View
* **Identify Row:** Shrink the "Identify with Artsorakel AI" button width. Place the `🧭` (Compass) follow icon next to it on the same line.
* **Header Row:** Add the Author's Avatar and Username in the top-right corner, aligned with the Species name. Also show the draft tag somwhere up there.
* **Social Controls:** * When viewing another user's find: Show `🤍` (Friend Request) and `🧭` (Follow User).
    * **Reciprocity:** Heart turns `❤️` when a friendship is accepted.
* **Sharing Section:** Keep the three buttons (`Private`, `Friends`, `Public`) but add a small `(1 slot)` label under Private and Friends for free users.

### Finds Tab (Main Feed)
* **New Tab:** Add **`Feed 🧭`** alongside `Mine`, `Friends`, and `Public`.
* **Draft Indicator:** Add a "Draft" corner badge to cards in the gallery that have `is_draft = true`.

---

## 3. Revised Phase 7 Todo-List for Agent

- [ ] **SQL Migration (Schema):**
    - [ ] Add `is_draft` (bool) and `location_precision` (text) to `observations`.
    - [ ] Create `follows` table (`user_id`, `target_type`, `target_id`).
- [ ] **SQL Migration (Triggers):**
    - [ ] Update `enforce_non_public_observation_limit()` to check for `(visibility != 'public' OR location_precision = 'fuzzed')`.
    - [ ] Increase the limit to **20** for non-pro users.
- [ ] **SQL Migration (Views):**
    - [ ] Update `observations_community_view` to show exact GPS by default.
    - [ ] Implement `observations_follow_view`.
- [ ] **Frontend (Find-Detail):**
    - [ ] Layout adjustment: Narrow ID button + Follow icon.
    - [ ] Layout adjustment: Username/Avatar in header.
    - [ ] Logic: Social toggle for `🤍` and `🧭`.
- [ ] **Frontend (Feed):**
    - [ ] Add the `Feed 🧭` tab.
    - [ ] Implement the "Draft" badge on gallery cards.


---

## Reconciling with your last SQL
Your last SQL established a solid foundation for `profiles.is_pro` and the `are_friends()` helpers. We can reuse those entirely. 

**What changes:**
1.  **Visibility Values:** We will shift the legacy `'draft'` visibility value to `'private'` to allow the new `is_draft` (WIP) boolean to handle the workflow state independently of privacy.
2.  **The Trigger:** The trigger logic needs to be expanded to watch the `location_precision` column as well.
3.  **The View:** The `observations_community_view` is currently rounding everything for strangers. We will change it to only round if the user has explicitly requested "fuzzing" via a privacy slot.

