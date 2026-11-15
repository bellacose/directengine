import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type DemoSession } from "./App.tsx";
import { makeClient } from "./supabase.ts";
import "./styles.css";

async function start() {
  let demo: DemoSession | undefined;
  // `vite --mode demo` only. In a production build this branch, and demo.ts with it, is removed.
  if (import.meta.env.MODE === "demo") {
    const { demoDb, DEMO_USER } = await import("./demo.ts");
    demo = { db: await demoDb(), user: DEMO_USER };
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App client={demo ? null : makeClient()} demo={demo} />
    </StrictMode>,
  );
}
start();
