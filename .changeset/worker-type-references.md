---
'@sveltejs/kit': patch
---

Include triple-slash type references in the worker declaration dependency graph to prevent worker-only globals from leaking into application types.
