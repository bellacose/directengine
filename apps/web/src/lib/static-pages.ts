/**
 * HTML files the build writes outside planPages(), relative to the output folder; the build test
 * checks the output against this list plus the plan. Only pages with no index state belong here:
 * an indexed page needs a sitemap entry, so it goes in the plan (the info and legal pages are
 * INFO_PAGES in packages/core). confirm-email/ is where the claim confirmation link lands (T19).
 */
export const STATIC_HTML = ["404.html", "confirm-email/index.html"];
