// Who gets the native folder picker (server/folderPicker.ts): a browser on this machine, whether it
// opened the server at localhost, at this machine's Tailscale or LAN address, or through
// `tailscale serve`; never a browser on another device.
import { describe, expect, test } from "bun:test";
import { ownAddresses, sameMachine } from "../server/folderPicker";

const own = ownAddresses({
  lo: [
    { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" },
    { address: "::1", family: "IPv6", internal: true, netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", mac: "00:00:00:00:00:00", cidr: "::1/128", scopeid: 0 },
  ],
  tailscale0: [
    { address: "100.101.102.103", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "00:00:00:00:00:00", cidr: "100.101.102.103/32" },
    { address: "fd7a:115c:a1e0::1234", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", mac: "00:00:00:00:00:00", cidr: "fd7a:115c:a1e0::1234/128", scopeid: 0 },
  ],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "aa:bb:cc:dd:ee:ff", cidr: "192.168.1.20/24" }],
});
const req = (host: string, headers: Record<string, string> = {}) => new Request(`http://${host}/api/native/folder`, { headers: { host, ...headers } });

describe("sameMachine", () => {
  test("a browser on localhost", () => {
    expect(sameMachine(req("localhost:4000"), "127.0.0.1", own)).toBe(true);
    expect(sameMachine(req("[::1]:4000"), "::1", own)).toBe(true);
    expect(sameMachine(req("127.0.0.1:4000"), "::ffff:127.0.0.1", own)).toBe(true);
  });

  test("a browser here that opened this machine's Tailscale address or MagicDNS name", () => {
    expect(sameMachine(req("100.101.102.103:4000"), "100.101.102.103", own)).toBe(true);
    expect(sameMachine(req("imac.tail1234.ts.net:4000"), "::ffff:100.101.102.103", own)).toBe(true);
    expect(sameMachine(req("[fd7a:115c:a1e0::1234]:4000"), "fd7a:115c:a1e0::1234", own)).toBe(true);
  });

  test("a browser here that opened this machine's LAN address", () => {
    expect(sameMachine(req("192.168.1.20:4000"), "192.168.1.20", own)).toBe(true);
  });

  test("another device, at whatever name it asks for", () => {
    expect(sameMachine(req("100.101.102.103:4000"), "100.90.1.2", own)).toBe(false);
    expect(sameMachine(req("localhost:4000"), "192.168.1.31", own)).toBe(false);
    // Saying it's here in a header it sent itself counts for nothing without a proxy on loopback.
    expect(sameMachine(req("imac:4000", { "x-forwarded-for": "100.101.102.103" }), "100.90.1.2", own)).toBe(false);
    expect(sameMachine(req("imac:4000"), undefined, own)).toBe(false);
  });

  test("through tailscale serve, the visitor's own address decides", () => {
    const serve = (from: string) => req("imac.tail1234.ts.net", { "x-forwarded-for": from });
    expect(sameMachine(serve("100.101.102.103"), "127.0.0.1", own)).toBe(true);
    expect(sameMachine(serve("100.90.1.2"), "127.0.0.1", own)).toBe(false);
    // A proxy that adds to the header puts the address it saw last.
    expect(sameMachine(serve("100.101.102.103, 100.90.1.2"), "127.0.0.1", own)).toBe(false);
    // A proxy that says nothing about its visitor can't vouch for one.
    expect(sameMachine(req("imac.tail1234.ts.net"), "127.0.0.1", own)).toBe(false);
  });
});
