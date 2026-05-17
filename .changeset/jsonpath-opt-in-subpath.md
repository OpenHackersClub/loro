---
"loro-crdt": major
---

`loro-crdt` is now a lean build by default. The `pest`-based JSONPath engine
(~66 KB gzip) is no longer bundled into the default entry point.

**Breaking:** `LoroDoc.JSONPath()` and `LoroDoc.subscribeJsonpath()` are no
longer available from `import { LoroDoc } from "loro-crdt"`. They have moved
to the `loro-crdt/jsonpath` subpath, which ships a JSONPath-enabled build:

```ts
// Before
import { LoroDoc } from "loro-crdt";

// After — only if you use JSONPath
import { LoroDoc } from "loro-crdt/jsonpath";
```

Code that does not use JSONPath needs no change and gets a ~66 KB gzip
smaller bundle.
