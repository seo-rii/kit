---
'@sveltejs/kit': patch
---

fix: reject offline remote cache variants on browser-controlled request headers, including Referer, Sec-Fetch-Mode, User-Agent, and Accept-Encoding
