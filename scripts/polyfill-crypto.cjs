"use strict";

const nodeCrypto = require("crypto");

function fill(typedArray) {
  const bytes = nodeCrypto.randomBytes(typedArray.byteLength);
  typedArray.set(bytes);
  return typedArray;
}

const impl =
  (typeof nodeCrypto.getRandomValues === "function" &&
    nodeCrypto.getRandomValues.bind(nodeCrypto)) ||
  (nodeCrypto.webcrypto &&
    nodeCrypto.webcrypto.getRandomValues.bind(nodeCrypto.webcrypto)) ||
  fill;

function ensure(target) {
  if (!target || typeof target.getRandomValues === "function") return;
  try {
    Object.defineProperty(target, "getRandomValues", {
      value: impl,
      configurable: true,
    });
  } catch {
    try {
      target.getRandomValues = impl;
    } catch {
      // ignore read-only exports
    }
  }
}

ensure(nodeCrypto);
ensure(nodeCrypto.webcrypto);
ensure(globalThis.crypto);
if (typeof globalThis.Crypto === "function") ensure(globalThis.Crypto);
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
  globalThis.crypto = nodeCrypto.webcrypto || { getRandomValues: impl };
}
