// SPDX-License-Identifier: Apache-2.0
// `pathrule ui` writes a fresh style nonce into index.html and allows it in the CSP.
// Radix's scroll lock injects a <style> element and reads the nonce from here.
const meta = document.querySelector<HTMLMetaElement>('meta[name="pr-style-nonce"]');
const nonce = meta?.content;
if (nonce && nonce !== "__PR_STYLE_NONCE__") {
  (globalThis as unknown as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
}
export {};
