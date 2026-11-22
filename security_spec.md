# Lodge Music — Security Specification (Phase 0)

## 1. Data Invariants

1. **Public Read-Only Catalog, Admin-Only Mutations**: Unauthenticated users (brethren using the shared public app) may read (`get`, `list`) ceremonial sets (`/sets/{setId}`) and their track buttons (`/sets/{setId}/tracks/{trackId}`), but must NEVER be able to create, update, or delete any document.
2. **Verified Owner/Admin Identity**: Only an authenticated user whose email is verified (`request.auth.token.email_verified == true`) and either matches the owner email (`robert.billing@gmail.com`) or exists in `/admins/{request.auth.uid}` may perform write operations.
3. **Strict Path & ID Integrity**: All document IDs (`setId`, `trackId`, `adminId`) must match `^[a-zA-Z0-9_-]+$` and be <= 128 chars, and `data.id` must equal the document path ID, while `track.setId` must equal the parent `setId`.
4. **Master Gate Relational Sync**: A track button (`/sets/{setId}/tracks/{trackId}`) cannot exist without a valid parent `/sets/{setId}` document (`existsAfter`).
5. **Immutable Audit Fields & Server Timestamps**: `id`, `setId`, and `createdAt` are immutable after creation. `createdAt` (on create) and `updatedAt` (on create/update) must equal `request.time`.
6. **Bounded Payloads & Allowlisted Fields**: All strings, arrays (`lyrics <= 100`), integers (`order`, `legacyId`), and button color enums (`darkblue`, `blue`, `yellow`, `green`, `red`, `orange`, `purple`) are strictly bounded and checked via `hasAll` / `hasOnly` / `affectedKeys().hasOnly()`.

## 2. The "Dirty Dozen" Adversarial Payloads (Expected: PERMISSION_DENIED)

1. **Unauthenticated Set Create**: Anonymous client attempts `setDoc(doc(db, 'sets', 'hack'), {...})`.
2. **Non-Admin Authenticated Track Create**: Signed-in non-owner user (`other@gmail.com`) attempts to add a button to `/sets/craft/tracks/evil`.
3. **Unverified Admin Email Spoof**: Signed-in user with `email: 'robert.billing@gmail.com'` and `email_verified: false` attempts to update a set.
4. **Ghost / Shadow Field Injection**: Admin attempts to create a track with an undeclared field `{ ..., isOfficial: true }`.
5. **Path ID Poisoning**: Admin attempts to create `/sets/../../../etc` or a 200-char set ID.
6. **Mismatched Body ID vs Path ID**: Admin writes to `/sets/craft` with `{ id: 'other_id', ... }`.
7. **Orphaned Track Creation**: Admin attempts to create `/sets/nonexistent_set/tracks/t1` without creating `/sets/nonexistent_set`.
8. **Cross-Set `setId` Forgery**: Admin creates `/sets/ea/tracks/t1` with `{ setId: 'craft', ... }`.
9. **Immutable `createdAt` Tampering**: Admin updates `/sets/craft` and attempts to change `createdAt` or spoof `updatedAt` to a past timestamp instead of `serverTimestamp()`.
10. **Invalid Button Color Enum**: Admin creates a track with `{ color: 'neon-pink', ... }`.
11. **Denial-of-Wallet Oversized Payload**: Admin creates a track with a 5,000-character `title` or 500 lines in `lyrics`.
12. **Privilege Escalation on `/admins`**: Non-admin user attempts to create `/admins/{theirUid}` with `{ role: 'admin' }`.
