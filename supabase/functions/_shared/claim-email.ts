/**
 * Email confirmation for owner claims (T19).
 *
 * 1. submit-claim stores the claim, then `sendClaimConfirmation` makes a random token, stores only its
 *    SHA-256 hash in `claim_email_tokens` (the database adds the 7-day expiry), and emails the contact
 *    address a link: https://{site domain}/confirm-claim/?token={token}.
 * 2. The host routes /confirm-claim/ on the site's domain to the `confirm-claim` function as
 *    /confirm-claim/{site}/ (apps/web/src/lib/host-routing.ts). `handleConfirmClaim` hashes the token
 *    and calls confirm_claim_email(hash), which marks the claim once and only once.
 * 3. The function answers with a 303 to the site's static /confirm-email/ page with
 *    #confirm-{outcome}, which the page shows with CSS (:target). Edge Functions can't serve HTML.
 *
 * Writes: one insert into claim_email_tokens, and the confirm_claim_email() call. Confirming never
 * publishes a listing, records a check or changes a fact; that stays with the admin's review.
 *
 * The email holds no text from the form, only the site's name and the listing's name from our own
 * database, so the claim form can't be used to send someone else a message of the sender's choosing.
 */

import { type Db, SLUG, text } from "./db.ts";
import type { EmailMessage, Mailer } from "./mail.ts";

/** How long a link works. The database sets and enforces it (claim_email_tokens.expires_at). */
export const CONFIRM_DAYS = 7;
/** Where the function sends the browser: a static page on the site (apps/web/src/pages/confirm-email.astro). */
export const CONFIRM_PAGE = "/confirm-email/";
/** The site path the link uses; the host routes it to the function. */
export const CONFIRM_PATH = "/confirm-claim/";

export type ConfirmOutcome = "confirmed" | "invalid" | "error";

/** What the page says for each outcome. A used, expired and unknown link all read the same. */
export const CONFIRM_MESSAGES: Record<ConfirmOutcome, string> = {
  confirmed: "Thanks, your email address is confirmed. We still review every submission by hand before anything changes on the site.",
  invalid: "This link doesn't work any more. Links work once and expire after 7 days. If you still need to confirm, send the form again.",
  error: "Something went wrong on our side. Please open the link again later.",
};

/** 32 random bytes in base64url: 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Lowercase hex SHA-256 of the token: what the database stores and looks up. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function newToken(): Promise<{ token: string; hash: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await hashToken(token) };
}

export const confirmLink = (domain: string, token: string) => `https://${domain}${CONFIRM_PATH}?token=${token}`;

/** The email. Fixed wording; only the site name, shop name and link vary. */
export function confirmationEmail(to: string, siteName: string, shopName: string | null, link: string): EmailMessage {
  const what = shopName ? `details about ${shopName}` : "details about a shop";
  return {
    to,
    subject: `Confirm your email for ${siteName}`,
    text: [
      `Someone used this email address to send ${what} to ${siteName}.`,
      "",
      `If that was you, open this link within ${CONFIRM_DAYS} days to confirm the address is yours:`,
      link,
      "",
      "The link works once. Confirming doesn't change anything on the site by itself: we review every submission by hand first.",
      "",
      "If it wasn't you, ignore this email. Nothing else will be sent.",
      "",
    ].join("\n"),
  };
}

export type SendResult = "sent" | "no-mailer" | "no-domain";

export interface ClaimEmailInput {
  claimId: string;
  to: string;
  site: { name: string; domain: string | null };
  /** The listed shop's name from our database; null for a shop we don't list yet. */
  shopName: string | null;
}

/**
 * Store a token for the claim and email the link. Without a mailer (no provider chosen) or a site
 * domain (H3) there is no link to send, so nothing is stored. Throws when the insert or the send fails;
 * the caller logs it and the claim stays unconfirmed. The token itself is never logged.
 */
export async function sendClaimConfirmation(db: Db, mailer: Mailer | undefined, input: ClaimEmailInput): Promise<SendResult> {
  if (!mailer) {
    console.warn("claim email: no email provider configured; the claim stays unconfirmed");
    return "no-mailer";
  }
  if (!input.site.domain) {
    console.warn("claim email: the site has no domain yet, so there is no link to send");
    return "no-domain";
  }
  const { token, hash } = await newToken();
  const { error } = await db.from("claim_email_tokens").insert({ claim_id: input.claimId, token_hash: hash });
  if (error) throw new Error(`claim_email_tokens insert failed: ${error.message}`);
  await mailer.send(confirmationEmail(input.to, input.site.name, input.shopName, confirmLink(input.site.domain, token)));
  return "sent";
}

const back = (outcome: ConfirmOutcome) =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `${CONFIRM_PAGE}#confirm-${outcome}`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // The token is in this request's URL; don't pass it on to the next page.
      "Referrer-Policy": "no-referrer",
    },
  });

/**
 * GET /confirm-claim/{site}/?token=... (from the link in the email). Only the token is read: no claim
 * ID or other parameter can confirm anything. A HEAD (some link checkers) confirms nothing.
 */
export async function handleConfirmClaim(req: Request, db: Db): Promise<Response> {
  if (req.method !== "GET") return text(405, "Method not allowed", { Allow: "GET" });
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/confirm-claim\/([^/]+)\/?$/);
  if (!m || !SLUG.test(m[1])) return text(404, "Not found");
  const token = url.searchParams.get("token") ?? "";
  if (!TOKEN.test(token)) return back("invalid");
  const { data, error } = await db.rpc("confirm_claim_email", { p_token_hash: await hashToken(token) });
  if (error) {
    console.error(`confirm_claim_email failed: ${error.message}`);
    return back("error");
  }
  return back(data === true ? "confirmed" : "invalid");
}
