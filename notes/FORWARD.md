# Forward links

**A forward link marks work worth doing. An unintentional dangling one is rot.**
Rule N4 makes the difference explicit: a `[[wikilink]]` in a note either
resolves to a note that exists, or is declared here.

Delete a line when its note lands. A name that sits here for a long time is
telling you something — either the module is overdue, or the link was wishful.

## Declared

| Link | Will be | Why it is linked already |
| --- | --- | --- |
| [[openapi]] | An L4 module | The last unbuilt piece of the route registry's reason for existing: `httproute` declares each route's request and reply schemas *so that* something can render a document from them without reading a handler. Linked from `notes/patterns/httproute.md` and `notes/patterns/conditional.md`, and the note names the gap it will close — nothing checks today that a handler's status appears in its `replies` map |
| [[validate]] | — | **Will not land.** `../MODULES.md` lists it for Go; here zod covers the boundary. Kept declared so the link in `notes/patterns/result.md` stays honest |
