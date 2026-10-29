---
'@sveltejs/kit': patch
---

fix: use the same service worker request identity for URL fragments so revoked remote responses cannot be cached by an earlier read
