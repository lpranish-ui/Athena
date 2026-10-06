# Dependency security patches

SDK 57 stays on its Expo-compatible versions. `npm install` and `npm ci` run
`scripts/patch-dependencies.cjs`; installation fails if the expected patch target
changes. `npm test` exercises normal behavior and the malicious inputs.

- `decode-uri-component` is overridden to patched 0.5.0, with a CommonJS/default
  interop adjustment for `query-string` 7. [Upstream advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
- `uuid` is overridden to 11.1.1, which retains CommonJS support and fixes buffer
  bounds validation. [Upstream advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
- `braces` 3.0.3 rejects AST nesting above 128 before its recursive walkers run.
  No patched npm release was available when this was added.
  [Upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- `node-forge` 1.4.0 checks the nested DigestAlgorithm element count, following
  the [upstream proposed fix](https://github.com/digitalbazaar/forge/pull/1152).
  No patched npm release was available when this was added.
  [Upstream advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

`npm audit` still reports affected versions of braces/node-forge and their parent
packages. That output does not account for local source patches. `npm run
audit:dependencies` permits only these two documented advisories; any new
advisory fails the check. Remove the backports when compatible upstream releases
become available, then rerun tests, Expo Doctor and a web export.
