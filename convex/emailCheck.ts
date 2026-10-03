// Checks on a waitlist address before it's accepted, none of which send any email: it has to look
// like an address, not be from a throwaway inbox service, and its domain has to accept mail. Plus a
// canonical form, so one inbox is one place in line.
import { isDisposableEmailDomain } from "disposable-email-domains-js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const looksLikeEmail = (email: string) => email.length <= 254 && EMAIL.test(email);

/**
 * The inbox an address delivers to: "+tags" dropped (nearly every provider ignores them), and for
 * Gmail the dots too. So "J.Doe+waitlist2@googlemail.com" and "jdoe@gmail.com" are one entry.
 */
export function canonicalEmail(email: string) {
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).toLowerCase().split("+")[0]!;
  let domain = email.slice(at + 1).toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

/** Throwaway inbox services (mailinator and ~4,500 others), including their subdomains. */
export function isDisposable(domain: string) {
  const parts = domain.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (isDisposableEmailDomain(parts.slice(i).join("."))) return true;
  }
  return false;
}

type DnsAnswer = { Status: number; Answer?: { type: number; data: string }[] };

/**
 * Whether the domain has mail servers (MX records), over DNS-over-HTTPS. "unknown" when no resolver
 * could be reached, so an outage doesn't turn real people away.
 */
export async function acceptsMail(domain: string): Promise<"yes" | "no" | "unknown"> {
  const resolvers = [
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
  ];
  for (const url of resolvers) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 4000);
    try {
      const res = await fetch(url, { headers: { Accept: "application/dns-json" }, signal: abort.signal });
      if (!res.ok) continue;
      const answer = (await res.json()) as DnsAnswer;
      if (answer.Status === 3) return "no"; // the domain doesn't exist
      if (answer.Status !== 0) continue;
      // MX records, minus a "null MX" ("0 ."), which is a domain saying it takes no mail.
      const mx = (answer.Answer ?? []).filter((a) => a.type === 15 && !/^\d+\s+\.?$/.test(a.data.trim()));
      return mx.length ? "yes" : "no";
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  return "unknown";
}
