/**
 * MV3 service workers have no `Buffer` global (unlike Node). The `bip39`
 * package (a transitive dependency of @fluxio/crypto) reaches for the
 * Node `Buffer` global internally regardless of runtime, so it needs a
 * polyfill here. Everything else in the wallet crypto stack
 * (ed25519-hd-key, tweetnacl, bs58, ethers v6) is Uint8Array-based and
 * needs no such shim.
 *
 * Injected as the first module of the background bundle via esbuild's
 * `inject` option (see build.mjs) — this file's side effect (setting
 * globalThis.Buffer) runs before any other bundled code.
 */
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}
