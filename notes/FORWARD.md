# Forward links

**A forward link marks work worth doing. An unintentional dangling one is rot.**
Rule N4 makes the difference explicit: a `[[wikilink]]` in a note either
resolves to a note that exists, or is declared here.

Delete a line when its note lands. A name that sits here for a long time is
telling you something — either the module is overdue, or the link was wishful.

## Declared

| Link | Will be | Why it is linked already |
| --- | --- | --- |
| [[crypto]] | `notes/patterns/crypto.md` | L3. The keyring; uses `random` for key material and nonces |
| [[httpx]] | `notes/patterns/httpx.md` | L4. Owns the `Kind` → status table, per invariant I7 |
| [[validate]] | — | **Will not land.** `../MODULES.md` lists it for Go; here zod covers the boundary. Kept declared so the link in `notes/patterns/result.md` stays honest |
