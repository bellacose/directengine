/// <reference types="astro/client" />
// Guide text (T10): Markdown files in content/guides/ at the repo root, one per slug in
// sites/guides.json. Titles and approval live in sites/guides.json, not in the files, so the
// files carry no frontmatter. Which guides a site builds comes from planPages() (rule 7).
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// `base` is relative to the Astro project root (apps/web).
const guides = defineCollection({
  loader: glob({ base: "../../content/guides", pattern: "*.md" }),
});

export const collections = { guides };
