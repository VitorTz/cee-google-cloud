// Remove registrations left by previous installable PWA versions.
// Keep the normal browser-responsive website; this does not install an app.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) =>
    Promise.all(registrations
      .filter((registration) => new URL(registration.scope).origin === location.origin)
      .map((registration) => registration.unregister())),
  ).catch(console.error);
  if ("caches" in window) {
    void caches.keys().then((keys) => Promise.all(
      keys.filter((name) => name.startsWith("cee-pwa-")).map((name) => caches.delete(name)),
    )).catch(console.error);
  }
}

// All UI modules register their listeners when imported. Keep the original modules
// as independent imports because several are intentionally side-effect-only.
import "./tabs/streets";
import "./tabs/zips";
import "./tabs/rules";
import "./tabs/cep-search";
import "./tabs/loec-scans";
import "./tabs/malote-scans";
import "./tabs/daily-ops";
import "./tabs/helpdesk";
import "./tabs/employees";
import "./tabs/account";
import "./tabs/bug-reports";
import "./tabs/loec-analysis";
import "./tabs/metrics";
import "./tabs/contact";
import "./auth";
import "../app";
