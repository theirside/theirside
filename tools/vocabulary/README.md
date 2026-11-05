# Path-word vocabulary

Builds `packages/shared/src/vocabulary-words.ts`: the words the SDK route learner sends as-is in strict path privacy (docs/privacy.md). Everything else in a path becomes `:id`.

```sh
node src/fetch.mjs   # APIs.guru specs → .cache/segments.json (path segments only; ~2,500 APIs, a few minutes)
node src/names.mjs   # names.txt (only when refreshing the names list)
node src/build.mjs   # vocabulary-words.ts + report.md
```

How a word gets in:

1. **Mined:** it is a literal path segment, or a part of one (`payment-methods` → payment, methods; `bulkUpdate` → bulk, update), in at least 5 different APIs of the [APIs.guru OpenAPI directory](https://github.com/APIs-guru/openapi-directory) (`--min-apis`).
2. **Seed:** `seed.txt` is always included.
3. **Names out:** words in `names.txt` are dropped unless they are seed words or used by at least 5 different providers (`--common-providers`): those are ordinary API words such as `mark` or `max`, listed in `report.md` as the residual risk.

Sources and licences: the APIs.guru directory is CC0 1.0; only single path words are taken from the specs (no spec content is stored or committed). `names.txt` is derived from [popular-names-by-country-dataset](https://github.com/sigpwned/popular-names-by-country-dataset) (CC0 1.0).
