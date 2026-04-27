// Optional per-host runtime config. The repo ships `config.example.json` as a
// template; the real `config.json` is gitignored so deployment-specific keys
// (analytics domains, etc) never end up in the public repo.
//
// Schema (all keys optional):
//   {
//     "plausible": {
//       // Pick ONE of these two patterns:
//       // (a) classic "data-domain" form (Plausible Cloud or self-hosted)
//       "domain": "example.com",
//       "src":    "https://plausible.io/js/script.js",
//       // (b) newer "tagged events" form (site is encoded in the script URL)
//       "src":  "https://plausible.web.org/js/pa-XXXXXXXX-YYYYYYYYYY.js",
//       "init": true
//     }
//   }

export async function loadHostConfig(url = 'config.json') {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

export function applyHostConfig(cfg) {
  if (!cfg) return;
  if (cfg.plausible) injectPlausible(cfg.plausible);
}

function injectPlausible({ domain, src, init = false } = {}) {
  if (!domain && !src) return;
  if (document.querySelector('script[data-plausible]')) return; // already injected

  const tag = document.createElement('script');
  tag.dataset.plausible = '1';
  tag.src = src || 'https://plausible.io/js/script.js';
  if (init) {
    tag.async = true;
  } else {
    tag.defer = true;
    if (domain) tag.dataset.domain = domain;
  }
  document.head.appendChild(tag);

  if (init) {
    // Tagged-events bootstrap stub (queues calls until the async script loads).
    const stub = document.createElement('script');
    stub.dataset.plausible = '1';
    stub.textContent =
      'window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},' +
      'plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()';
    document.head.appendChild(stub);
  }
}
