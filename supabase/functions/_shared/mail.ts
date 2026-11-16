/**
 * Outgoing email, behind one small interface so the provider is a choice for later (T19, D28).
 *
 * No provider is chosen yet, so `mailerFromEnv` returns undefined and nothing is sent: claims are
 * stored as before and stay unconfirmed until the admin approves them with the override. Adding a
 * provider means one function here that turns an EmailMessage into that provider's API call, with its
 * key read from the function's secrets (EMAIL_API_KEY) and the sender from EMAIL_FROM. Nothing else
 * changes.
 *
 * The tests use `memoryMailer()`, which keeps what would have been sent.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text only: no HTML, no tracking pixels. */
  text: string;
}

export interface Mailer {
  /** Resolves once the provider accepted the message; throws if it didn't. */
  send(msg: EmailMessage): Promise<void>;
}

/** The test double: records every message instead of sending it. `fail` makes send throw. */
export function memoryMailer(opts: { fail?: boolean } = {}): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(msg) {
      if (opts.fail) throw new Error("memory mailer: told to fail");
      sent.push(msg);
    },
  };
}

/**
 * The deployed functions' mailer, from their secrets. Until Chris picks a provider (D28) there is none:
 * this returns undefined whatever is set, and the claim form carries on without sending.
 */
export function mailerFromEnv(_get: (name: string) => string | undefined): Mailer | undefined {
  return undefined;
}
