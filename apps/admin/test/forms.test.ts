// The check form and the listing form refuse wrong values before anything is sent.

import { describe, expect, it, vi } from "vitest";
import * as api from "../src/lib/api.ts";
import type { Db } from "../src/lib/db.ts";
import { buildCheck, DAYS, factState, formatValue, inputFromValue, parseFactValue, type CheckForm, type DayInput, type FactDef } from "../src/lib/facts.ts";
import { buildCore, emptyCore, slugify } from "../src/lib/listing.ts";

const def = (key: string, value_type: FactDef["value_type"]): FactDef => ({ key, label: key, value_type, fact_group: "g", sort: 0 });
const DEFS = [
  def("t", "text"), def("b", "boolean"), def("n", "number"), def("tm", "time"), def("u", "url"), def("h", "hours"),
];
const TODAY = "2026-11-15";
const form = (over: Partial<CheckForm> = {}): CheckForm => ({
  method: "phone_call", checkedBy: "chris", checkedAt: TODAY, note: "", evidenceUrl: "", core: [], facts: {}, ...over,
});
const days = (over: Partial<Record<(typeof DAYS)[number], DayInput>> = {}) =>
  Object.fromEntries(DAYS.map((d) => [d, over[d] ?? { state: "unknown", open: "", close: "" }])) as Record<(typeof DAYS)[number], DayInput>;

describe("parseFactValue", () => {
  it.each([
    ["text", "  Gang sheets only  ", "Gang sheets only"],
    ["url", "https://example.com/files", "https://example.com/files"],
    ["time", "09:30", "09:30"],
    ["number", "6.5", 6.5],
    ["number", "22", 22],
    ["boolean", "true", true],
    ["boolean", "false", false],
  ] as const)("%s accepts %j", (type, text, value) => {
    expect(parseFactValue(type, { action: "set", text })).toEqual({ ok: true, value });
  });

  it.each([
    ["text", "   "],
    ["url", "example.com"],
    ["url", "ftp://example.com"],
    ["time", "2pm"],
    ["time", "24:00"],
    ["time", "9:30"],
    ["number", "six"],
    ["number", ""],
    ["number", "6,5"],
    ["number", "1e3"],
    ["boolean", ""],
    ["boolean", "yes"],
  ] as const)("%s rejects %j", (type, text) => {
    expect(parseFactValue(type, { action: "set", text }).ok).toBe(false);
  });

  it("hours: open days, closed days, unchecked days left out", () => {
    const r = parseFactValue("hours", {
      action: "set",
      days: days({ mon: { state: "open", open: "09:00", close: "17:00" }, sun: { state: "closed", open: "", close: "" } }),
    });
    expect(r).toEqual({ ok: true, value: { mon: { open: "09:00", close: "17:00" }, sun: null } });
  });

  it.each([
    [{ mon: { state: "open", open: "17:00", close: "09:00" } }, /before close/],
    [{ mon: { state: "open", open: "9", close: "17:00" } }, /HH:MM/],
    [{}, /at least one day/],
  ] as const)("hours rejects %j", (d, msg) => {
    const r = parseFactValue("hours", { action: "set", days: days(d as never) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it("round-trips stored values into inputs", () => {
    const stored = { mon: { open: "09:00", close: "17:00" }, sun: null };
    expect(parseFactValue("hours", { ...inputFromValue("hours", stored), action: "set" })).toEqual({ ok: true, value: stored });
    expect(parseFactValue("number", { ...inputFromValue("number", 6.5), action: "set" })).toEqual({ ok: true, value: 6.5 });
    expect(parseFactValue("boolean", { ...inputFromValue("boolean", false), action: "set" })).toEqual({ ok: true, value: false });
  });
});

describe("buildCheck", () => {
  it("builds record_check arguments from set, confirm, clear and core keys", () => {
    const r = buildCheck("L1", form({
      core: ["phone"],
      note: " Spoke to owner ",
      evidenceUrl: "https://example.com",
      facts: {
        t: { action: "set", text: "x" },
        b: { action: "confirm" },
        n: { action: "clear" },
        tm: { action: "keep", text: "garbage is ignored when kept" },
      },
    }), DEFS, new Set(["b", "n"]), TODAY);
    expect(r).toEqual({
      ok: true,
      args: {
        p_listing: "L1", p_method: "phone_call", p_checked_by: "chris", p_facts: { t: "x", n: null },
        p_confirmed: ["phone", "b"], p_checked_at: TODAY, p_note: "Spoke to owner", p_evidence_url: "https://example.com",
      },
    });
  });

  it("refuses wrongly typed values, keyed by fact", () => {
    const r = buildCheck("L1", form({
      facts: { b: { action: "set", text: "maybe" }, n: { action: "set", text: "lots" }, tm: { action: "set", text: "2 PM" }, t: { action: "set", text: "ok" } },
    }), DEFS, new Set(), TODAY);
    expect(r.ok).toBe(false);
    expect(Object.keys(!r.ok ? r.errors : {}).sort()).toEqual(["b", "n", "tm"]);
  });

  it("refuses a bad header: method, who, future date, evidence URL", () => {
    const r = buildCheck("L1", form({
      method: "guess", checkedBy: " ", checkedAt: "2026-11-16", evidenceUrl: "example.com", facts: { t: { action: "set", text: "x" } },
    }), DEFS, new Set(), TODAY);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["checkedAt", "checkedBy", "evidenceUrl", "method"]);
  });

  it("refuses a check that confirms nothing, and confirming a fact with no value", () => {
    expect(buildCheck("L1", form(), DEFS, new Set(), TODAY)).toEqual({ ok: false, errors: { form: expect.stringMatching(/at least one/) } });
    expect(buildCheck("L1", form({ facts: { n: { action: "clear" } } }), DEFS, new Set(["n"]), TODAY).ok).toBe(false);
    const r = buildCheck("L1", form({ facts: { b: { action: "confirm" } } }), DEFS, new Set(), TODAY);
    expect(!r.ok && r.errors.b).toMatch(/no value to confirm/);
  });

  it("refuses unknown fact and core keys", () => {
    expect(buildCheck("L1", form({ facts: { nope: { action: "set", text: "x" } } }), DEFS, new Set(), TODAY).ok).toBe(false);
    expect(buildCheck("L1", form({ core: ["rating"] }), DEFS, new Set(), TODAY).ok).toBe(false);
  });

  it("a rejected form never reaches the database", async () => {
    const db = { rpc: vi.fn() } as unknown as Db;
    const r = await api.recordCheck(db, "L1", form({ facts: { n: { action: "set", text: "six" } } }), DEFS, new Set(), TODAY);
    expect(r.ok).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("an accepted form calls record_check once with the built arguments", async () => {
    const db = { rpc: vi.fn().mockResolvedValue("event-1") } as unknown as Db;
    const r = await api.recordCheck(db, "L1", form({ facts: { n: { action: "set", text: "6" } } }), DEFS, new Set(), TODAY);
    expect(r).toEqual({ ok: true, id: "event-1" });
    expect(db.rpc).toHaveBeenCalledWith("record_check", expect.objectContaining({ p_listing: "L1", p_facts: { n: 6 } }));
  });
});

describe("fact display", () => {
  it("states", () => {
    expect(factState(undefined)).toBe("not_checked");
    expect(factState({ verified: false, stale: false })).toBe("unverified");
    expect(factState({ verified: true, stale: true })).toBe("stale");
    expect(factState({ verified: true, stale: false })).toBe("verified");
  });
  it("formats", () => {
    expect(formatValue("boolean", false)).toBe("No");
    expect(formatValue("hours", { mon: { open: "09:00", close: "17:00" }, sun: null })).toBe("mon 09:00-17:00, sun closed");
  });
});

describe("listing core fields", () => {
  const good = { ...emptyCore(), name: " Example Prints ", slug: "example-prints", city: "Tampa", state: "FL" };

  it("accepts a minimal draft and nulls blank optional fields", () => {
    const r = buildCore(good);
    expect(r.ok && r.row).toMatchObject({ name: "Example Prints", slug: "example-prints", zip: null, website: null, lat: null });
  });

  it("refuses values the table would refuse", () => {
    const r = buildCore({ ...good, slug: "Example Prints", state: "fl", zip: "3360", website: "example.com", lat: "95", description: "x".repeat(501) });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["description", "lat", "slug", "state", "website", "zip"]);
  });

  it("slugify", () => {
    expect(slugify("Example Prints & Co. (Tampa)")).toBe("example-prints-and-co-tampa");
    expect(slugify("Café Laser")).toBe("cafe-laser");
  });
});

describe("affiliate inputs", () => {
  it("site link rules", () => {
    expect(api.siteAffiliateErrors("approved", "")).toHaveLength(1);
    expect(api.siteAffiliateErrors("approved", "http://x")).toHaveLength(1);
    expect(api.siteAffiliateErrors("applied", "")).toEqual([]);
    expect(api.siteAffiliateErrors("approved", "https://x.example/r")).toEqual([]);
  });
  it("supplier notes need their date", () => {
    expect(api.supplierNoteErrors("By 2 PM", "", "", TODAY)).toHaveLength(1);
    expect(api.supplierNoteErrors("By 2 PM", "", "2026-11-16", TODAY)).toHaveLength(1);
    expect(api.supplierNoteErrors("By 2 PM", "$5/ft", TODAY, TODAY)).toEqual([]);
    expect(api.supplierNoteErrors("", "", "", TODAY)).toEqual([]);
  });
});
