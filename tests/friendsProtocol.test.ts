import { expect, test } from "bun:test";
import { cleanName, decodeInvite, encodeInvite, joinProof, keyId, loadKeyPair, newKeyPair, peek, sameProof, seal, unseal } from "../server/friends/protocol";
import { fingerprintOf, parseFriendAuthor, friendAuthor } from "../shared/friends";

// The friend protocol's stateless pieces: nothing here reads or writes a data directory.
const alice = loadKeyPair(newKeyPair());
const bob = loadKeyPair(newKeyPair());
const mallory = loadKeyPair(newKeyPair());

test("a sealed frame opens only with its sender's key, unchanged, and says truly who sent it", () => {
  const frame = seal({ t: "msg", from: alice.id, to: bob.id, seq: 3, kind: "chat.message", body: { text: "hi" } }, alice);
  expect(unseal(frame, alice.publicKey)).toEqual({ t: "msg", from: alice.id, to: bob.id, seq: 3, kind: "chat.message", body: { text: "hi" } });
  // Someone else's key, or a key that didn't sign it.
  expect(unseal(frame, bob.publicKey)).toBeUndefined();
  expect(unseal(frame, mallory.publicKey)).toBeUndefined();

  // Any change to the payload, however small, breaks the signature.
  const outer = JSON.parse(frame);
  for (const p of [outer.p.replace('"seq":3', '"seq":4'), outer.p.replace("hi", "hI"), outer.p + " ", outer.p.replace(bob.id, mallory.id)]) {
    expect(unseal(JSON.stringify({ ...outer, p }), alice.publicKey)).toBeUndefined();
  }
  // A signature from elsewhere, or a mangled one.
  const other = JSON.parse(seal({ t: "msg", from: alice.id, to: bob.id, seq: 3 }, alice));
  expect(unseal(JSON.stringify({ p: outer.p, s: other.s }), alice.publicKey)).toBeUndefined();
  // Swap the first char (never a padding bit) for a different one, so the mangled signature always differs.
  const mangled = (outer.s[0] === "A" ? "B" : "A") + outer.s.slice(1);
  expect(mangled).not.toBe(outer.s);
  expect(unseal(JSON.stringify({ p: outer.p, s: mangled }), alice.publicKey)).toBeUndefined();
  for (const junk of ["", "{}", "null", "[]", JSON.stringify({ p: 1, s: outer.s }), "x".repeat(70_000), 42, undefined]) expect(unseal(junk, alice.publicKey)).toBeUndefined();

  // Mallory signing a frame that claims to be Alice's: opens with no key at all.
  const forged = seal({ t: "msg", from: alice.id, to: bob.id, seq: 9 }, mallory);
  expect(unseal(forged, alice.publicKey)).toBeUndefined();
  expect(unseal(forged, mallory.publicKey)).toBeUndefined();
  // peek reads without trusting: only to find which key should have signed.
  expect(peek(forged)?.from).toBe(alice.id);
});

test("an invite code carries the host's addresses, key and secret, and nothing that isn't one decodes", () => {
  const invite = { id: "abcdefghijklmnop", secret: "s3cr3t-s3cr3t-s3cr3t", key: alice.publicKey, name: "Alice", mode: "tailscale" as const, urls: ["http://100.64.1.2:3200", "http://alice-box.tail1234.ts.net:3200"], expiresAt: Math.floor(Date.now() / 1000) * 1000 + 900_000 };
  const code = encodeInvite(invite);
  expect(code.startsWith("obf1_")).toBe(true);
  expect(decodeInvite(code)).toEqual(invite);
  // Pasted with spaces and line breaks.
  expect(decodeInvite(`  ${code.slice(0, 20)}\n${code.slice(20)}  `)).toEqual(invite);
  expect(keyId(decodeInvite(code)!.key)).toBe(alice.id);
  // Through a tunnel: the route's https address, and the mode, come back as they went.
  const tunneled = { ...invite, mode: "tunnel" as const, urls: ["https://f0123456789abcdef0123.t1.tunnel.example.com"] };
  expect(decodeInvite(encodeInvite(tunneled))).toEqual(tunneled);
  for (const bad of ["", "obf1_", "obf1_!!!!", code.slice(5), "obf2_" + code.slice(5), encodeInvite({ ...invite, urls: ["file:///etc/passwd"] }), encodeInvite({ ...invite, urls: ["http://x/path"] }), encodeInvite({ ...invite, key: "short" })]) {
    expect(decodeInvite(bad)).toBeUndefined();
  }
  // A name is one short, plain line wherever it came from.
  expect(decodeInvite(encodeInvite({ ...invite, name: "Al\nice \u0007 ".repeat(20) }))!.name).toBe(cleanName("Al\nice \u0007 ".repeat(20)));
  expect(cleanName("Al\nice x\u0000y")).toBe("Al ice x y");
});

test("a join proof shows the code without sending it, bound to the invite, the key and the nonce", () => {
  const input = { invite: "abcdefghijklmnop", from: bob.id, nonce: "n1" };
  const proof = joinProof("c2VjcmV0LXNlY3JldC1zZWNyZXQ", input);
  expect(sameProof(proof, joinProof("c2VjcmV0LXNlY3JldC1zZWNyZXQ", input))).toBe(true);
  expect(sameProof(proof, joinProof("b3RoZXItc2VjcmV0LW90aGVy", input))).toBe(false);
  expect(sameProof(proof, joinProof("c2VjcmV0LXNlY3JldC1zZWNyZXQ", { ...input, from: mallory.id }))).toBe(false);
  expect(sameProof(proof, joinProof("c2VjcmV0LXNlY3JldC1zZWNyZXQ", { ...input, nonce: "n2" }))).toBe(false);
  expect(sameProof(undefined, proof)).toBe(false);
});

test("friend authors and fingerprints", () => {
  const author = friendAuthor(alice.id, "owner");
  expect(parseFriendAuthor(author)).toEqual({ friend: alice.id, member: "owner" });
  expect(parseFriendAuthor("me")).toBeUndefined();
  expect(parseFriendAuthor(`friend:${alice.id}:../x`)).toBeUndefined();
  expect(fingerprintOf(alice.id)).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}$/);
});
