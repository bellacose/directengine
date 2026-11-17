import { useState } from "react";
import type { ThemeVariables } from "@directory-engine/core";
import { useApp } from "../context.ts";
import { loadSiteSettings, saveSiteSettings, settingsForm, siteSettingsErrors, type SettingsForm, type SiteRow, type SiteSettingsRow } from "../lib/api.ts";
import { SITE_CONFIGS, THEME_FONTS } from "../siteConfigs.ts";
import { FieldError, fmtDate, Loading, Notice, useAction, useLoad } from "../ui.tsx";

/**
 * Per-site settings that change without a code change (D31): the name, the operator shown on the
 * about, privacy and contact pages, and the theme (a Tailwind config and its CSS, pasted from a theme
 * generator). Blank fields use the site file's value. The live site changes on its next build.
 */
export function SiteSettings() {
  const { db } = useApp();
  const { data, error, reload } = useLoad(() => loadSiteSettings(db), [db]);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <h1>Site settings</h1>
      <p className="small muted">
        Blank fields use the value in <code>sites/&lt;slug&gt;.json</code>. Saved changes show on the live site after its next build.
      </p>
      {!data.sites.length && <p className="muted">No sites in the database yet. Run <code>npm run sync-sites</code>.</p>}
      {data.sites.map((s) => (
        <SiteForm key={s.id} site={s} row={data.settings.find((r) => r.site_id === s.id)} onSaved={reload} />
      ))}
    </>
  );
}

function SiteForm({ site, row, onSaved }: { site: SiteRow; row: SiteSettingsRow | undefined; onSaved: () => void }) {
  const { db } = useApp();
  const file = SITE_CONFIGS.find((c) => c.slug === site.slug);
  const brand = file?.brand ?? { primary: "#000000", accent: "#000000" };
  const [form, setForm] = useState<SettingsForm>(() => settingsForm(row));
  const action = useAction();
  const { errors, theme } = siteSettingsErrors(form, brand);
  const changed = JSON.stringify(form) !== JSON.stringify(settingsForm(row));
  const set = (k: keyof SettingsForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const missingFonts = theme?.families.filter((f) => !THEME_FONTS.has(f)) ?? [];

  return (
    <section className="panel">
      <h2>{form.name.trim() || file?.name || site.name} <span className="muted small">{site.domain ?? "no domain yet"} · saved {fmtDate(row?.updated_at)}</span></h2>
      <div className="grid">
        <label>Site name<input value={form.name} placeholder={file?.name} onChange={set("name")} /></label>
        <label>Operator name<input value={form.operatorName} placeholder={file?.operator?.name ?? "not set"} onChange={set("operatorName")} /></label>
        <label>Operator email<input type="email" value={form.operatorEmail} placeholder={file?.operator?.email ?? "not set"} onChange={set("operatorEmail")} /></label>
      </div>

      <h3>Theme</h3>
      <p className="small muted">
        Paste the Tailwind config and the CSS variables (<code>:root {"{ --primary: … }"}</code>) from your theme generator. They're read as
        data, never run. Empty uses {file?.theme ? <>the <code>{file.theme}</code> theme folder</> : "the site file's colors"}.
      </p>
      <div className="grid wide">
        <label>Tailwind config<textarea className="code" rows={12} spellCheck={false} value={form.themeConfig} onChange={set("themeConfig")} /></label>
        <label>Theme CSS<textarea className="code" rows={12} spellCheck={false} value={form.themeCss} onChange={set("themeCss")} /></label>
      </div>
      {theme && <ThemePreview vars={theme.variables} />}
      {missingFonts.length > 0 && (
        <p className="small muted">
          No font file yet for {missingFonts.join(", ")}: the next font in the list is used until a <code>.woff2</code> is added to a theme's <code>fonts/</code> folder.
        </p>
      )}

      <FieldError msg={errors.join(" ")} />
      {action.msg && <Notice kind={action.msg.kind}>{action.msg.text}</Notice>}
      <button
        disabled={!changed || errors.length > 0 || action.busy}
        onClick={() => action.run(async () => {
          await saveSiteSettings(db, site.id, form, brand, !!row);
          onSaved();
          return "Saved. The live site picks this up on its next build.";
        })}
      >
        Save settings
      </button>
    </section>
  );
}

/** A small sample of the page in the theme's colors, so a theme can be judged before saving. */
function ThemePreview({ vars: v }: { vars: ThemeVariables }) {
  const swatches: [string, string | undefined][] = [
    ["primary", v.brand], ["accent", v.accent], ["background", v.paper], ["text", v.ink],
    ["muted", v.surface], ["muted text", v.muted], ["border", v.line],
  ];
  return (
    <div className="theme-preview" style={{ background: v.paper, color: v.ink, borderColor: v.line, borderRadius: v.radius, fontFamily: v.font }}>
      <strong style={{ fontFamily: v["font-display"] ?? v.font }}>DTF transfers in Tampa Bay</strong>
      <p style={{ color: v.muted, margin: "4px 0" }}>Last checked Nov 16, 2026 · <span style={{ color: v.accent, fontWeight: 600 }}>Same-day by 2:00 PM</span></p>
      <span className="theme-btn" style={{ background: v.brand, color: v["on-brand"] ?? "#fff", borderRadius: v.radius }}>Call</span>
      <span className="theme-chip" style={{ background: v.surface, borderColor: v.line, borderRadius: v.radius }}>Walk-in pickup</span>
      <div className="swatches">
        {swatches.filter(([, c]) => c).map(([name, c]) => (
          <span key={name} className="small"><i style={{ background: c }} /> {name} <code>{c}</code></span>
        ))}
      </div>
    </div>
  );
}
