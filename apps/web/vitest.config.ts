import { defineConfig } from "vitest/config";
// Files run one at a time: two test files build the Astro app, and parallel builds would share apps/web's caches.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 600_000, fileParallelism: false } });
