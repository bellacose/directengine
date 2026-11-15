// Text built from config for the info and legal pages: operator and email (set and unset), coverage,
// headline and approved programs. The pages themselves are checked in build.test.ts.

import { planPages, type SiteConfig } from "@directory-engine/core";
import { describe, expect, it } from "vitest";
import { approvedPrograms, coverage, headlineLabel, infoSlug, listText, operatorEmail, operatorName } from "../src/lib/info.ts";
import { loadSite, type SiteAffiliate } from "../src/lib/load.ts";
import { root } from "./helpers.ts";

const load = (site: string) => loadSite({ root, env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } });

describe("info page helpers", () => {
  it("names the operator and email from config, or nothing while unset", async () => {
    const { site } = await load("dtf");
    const unset: SiteConfig = { ...site, operator: null };
    expect(operatorName(unset)).toBeNull();
    expect(operatorEmail(unset)).toBeNull();
    const nameOnly: SiteConfig = { ...site, operator: { name: "Someone LLC" } };
    expect(operatorName(nameOnly)).toBe("Someone LLC");
    expect(operatorEmail(nameOnly)).toBeNull();
    const full: SiteConfig = { ...site, operator: { name: "Someone LLC", email: "hi@site.test" } };
    expect(operatorEmail(full)).toBe("hi@site.test");
  });

  it("joins lists as prose", () => {
    expect(listText([])).toBe("");
    expect(listText(["A"])).toBe("A");
    expect(listText(["A", "B"])).toBe("A and B");
    expect(listText(["A", "B", "C"])).toBe("A, B and C");
  });

  it("describes coverage from the config and the plan, by display name", async () => {
    const dtf = await load("dtf");
    const c = coverage(dtf.site, planPages(dtf.site, dtf), dtf.vocabulary);
    const names = (slugs: string[], list: { slug: string; name: string }[]) => slugs.map((s) => list.find((x) => x.slug === s)!.name);
    expect(c.capabilities).toEqual(names(dtf.site.pages.capabilityMetro, dtf.vocabulary.capabilities));
    expect(c.metros.length).toBeGreaterThan(0);
    expect(c.metros.every((m) => dtf.vocabulary.metros.some((v) => v.name === m))).toBe(true);

    const tampa = await load("tampa-makers");
    expect(coverage(tampa.site, planPages(tampa.site, tampa), tampa.vocabulary).metros).toEqual(names(tampa.site.filter.metros!, tampa.vocabulary.metros));
  });

  it("names the headline fact by its label, or null without one", async () => {
    const dtf = await load("dtf");
    const label = dtf.vocabulary.factDefs.find((d) => d.key === dtf.site.angle.headline)!.label;
    expect(headlineLabel(dtf.site, dtf.vocabulary)).toBe(label);
    expect(headlineLabel({ ...dtf.site, angle: { ...dtf.site.angle, headline: null } }, dtf.vocabulary)).toBeNull();
  });

  it("lists only approved programs with a link", () => {
    const a = (name: string, status: string, url: string | null): SiteAffiliate => ({
      slug: name.toLowerCase(), name, status, url, hasSupplierFacts: false, factsCheckedAt: null, placements: [], cutoffNote: null, priceNote: null,
    });
    expect(approvedPrograms([a("Zeta", "approved", "https://z.test"), a("Beta", "applied", null), a("Alpha", "approved", "https://a.test")])).toEqual(["Alpha", "Zeta"]);
  });

  it("reads the info slug from a path", () => {
    expect(infoSlug("/privacy/")).toBe("privacy");
  });
});
