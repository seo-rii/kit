---
'@sveltejs/kit': patch
---

Preserve route precedence when resolving service worker fallbacks so a catch-all worker cannot handle data or actions for a more specific route without a worker.
