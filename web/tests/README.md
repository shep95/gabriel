# console tests

`e2e.mjs` drives the built console in headless chromium against a local static
server. it creates profiles on separate browser contexts, takes them offline,
pairs them by exchanging codes, moves an encrypted note across, and checks that
no request ever leaves the origin.

```
cd web
node tests/e2e.mjs
```

screenshots land in `tests/shots/` (ignored by git).
