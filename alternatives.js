// The "Alternatives" page: asks the alternatives server for options, then shows a short, simple list.
// Only the service NAME and its category are sent (never your price, email or account).
(function () {
  const SHORT = 5;
  let H = null, S = null, run = 0, timer = null;

  const safeUrl = u => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch (e) { return ""; } };
  const isFreeish = it => !!(it.openSource || it.cost === "free" || it.cost === "freemium");
  const countryName = code => { try { return code ? new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase()) : ""; } catch (e) { return ""; } };

  // The product's own icon, loaded from its own website. If it can't be loaded, the letter logo underneath stays visible.
  function logoFor(it) {
    const site = safeUrl(it.website); let img = "";
    if (site) { const o = new URL(site).origin; img = `<img src="${H.esc(o)}/apple-touch-icon.png" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="if(!this.dataset.t){this.dataset.t=1;this.src='${H.esc(o)}/favicon.ico'}else{this.remove()}">`; }
    return `<span class="alt-logo">${H.logoHtml(it.name)}${img}</span>`;
  }

  function freePlanText(it) {
    if (it.cost === "free") return "Completely free";
    if (it.cost === "freemium") return "Available";
    if (it.openSource) return "Open source";
    return "Not listed";
  }

  function cardHtml(it) {
    const site = safeUrl(it.website);
    // "available" is only shown when the server has real evidence. Until then every product is honestly "Unverified".
    const state = it.availability === "available" ? "available" : "unverified";
    const badge = state === "available" ? `<span class="alt-badge ok">Available</span>` : `<span class="alt-badge unv">Unverified</span>`;
    const sub = it.category || (it.platforms && it.platforms.length ? "Works on " + it.platforms.slice(0, 3).join(", ") : "");
    const priceLink = safeUrl(it.pricingUrl) || site;
    const pricing = priceLink ? `<a href="${H.esc(priceLink)}" target="_blank" rel="noopener noreferrer">Check current pricing</a>` : `<b>Check current pricing</b>`;
    return `<article class="alt-card">
      <div class="alt-top">${logoFor(it)}<div class="n"><b>${H.esc(it.name)}</b>${sub ? `<div class="alt-sub">${H.esc(sub)}</div>` : ""}</div>${badge}</div>
      <div class="alt-rows">
        <div class="alt-row"><span>Pricing</span>${pricing}</div>
        <div class="alt-row"><span>Free plan</span><b>${H.esc(freePlanText(it))}</b></div>
      </div>
      ${it.blurb ? `<p class="alt-blurb">${H.esc(it.blurb)}</p>` : ""}
      ${isFreeish(it) ? `<p class="alt-good">Potential free alternative</p>` : ""}
      ${it.needsSetup ? `<p class="alt-warn">Needs technical setup. You run it yourself, so you may need to pay for hosting.</p>` : ""}
      ${site ? `<a class="btn ghost alt-go" href="${H.esc(site)}" target="_blank" rel="noopener noreferrer">Explore alternative <span aria-hidden="true">↗</span></a>` : ""}
    </article>`;
  }

  // Free and open-source options first, keeping the server's order inside each part.
  const ordered = items => items.filter(isFreeish).concat(items.filter(i => !isFreeish(i)));

  function render() {
    const box = H.el; if (!S) return;
    const name = S.country ? countryName(S.country) : "";
    const title = `<div class="alt-title"><h1 style="font-size:32px;margin:0">Explore alternatives</h1>${name ? `<span class="alt-badge ok">${H.esc(name)}</span>` : ""}</div>`;
    if (S.state === "loading") { box.innerHTML = title + `<p class="lead" style="font-size:16px" role="status">Looking for alternatives to ${H.esc(S.sub.name)}… this can take up to a minute the first time.</p>`; return; }
    if (S.state === "error") {
      const msg = S.reason === "not_configured" ? "Alternatives aren’t switched on yet." : S.reason === "busy" ? "Alternatives are busy right now. Try again in a few minutes." : "We couldn’t load alternatives right now. Check your connection and try again.";
      box.innerHTML = title + `<p class="lead" style="font-size:16px">${H.esc(msg)}</p><p><button class="btn" id="alt-retry">Try again</button> <a class="btn ghost" href="#dashboard">Back to dashboard</a></p>`; return;
    }
    const list = ordered(S.items);
    if (!list.length) {
      box.innerHTML = title + `<p class="lead" style="font-size:16px">We couldn’t find good alternatives to ${H.esc(S.sub.name)} yet.</p><p><a class="btn ghost" href="#dashboard">Back to dashboard</a></p>`; return;
    }
    const n = S.expanded ? list.length : Math.min(list.length, SHORT);
    const more = list.length > n || S.hasMore;
    const where = name ? "in " + name : "in your country";
    box.innerHTML = title +
      `<p class="lead" style="font-size:16px">Looking for alternatives to ${H.esc(S.sub.name)}? Here are some options worth exploring.</p>` +
      (list.slice(0, n).some(i => i.availability !== "available") ? `<p class="alt-cnote">Please check that these are available ${H.esc(where)}, and that you can pay for them, before you sign up.</p>` : "") +
      (S.fallback ? `<p class="note">We couldn’t find an exact match for ${H.esc(S.sub.name)}, so these are popular tools that do a similar job.</p>` : "") +
      list.slice(0, n).map(cardHtml).join("") +
      (more ? `<p><button class="btn" id="alt-more"${S.loadingMore ? " disabled" : ""}>${S.loadingMore ? "Loading…" : "See more alternatives"}</button></p>` : "") +
      (S.stale ? `<p class="note">Showing saved results. We couldn’t refresh them just now.</p>` : "") +
      `<p class="note">Availability is checked automatically from each product’s own website and may not be exact. Plans and prices differ by country, so check the website before you sign up. Suggestions use public data from AlternativeTo.</p>` +
      `<p><a class="btn ghost" href="#dashboard">Back to dashboard</a></p>`;
  }

  function merge(old, fresh) {
    const seen = new Map(old.map(x => [x.slug, x]));
    fresh.forEach(x => seen.set(x.slug, x));
    return Array.from(seen.values());
  }

  async function fetchPage(page) {
    const base = (H.cfg.altApi || "").replace(/\/?$/, "/");
    const u = base + "alternatives?service=" + encodeURIComponent(S.sub.name) + "&cat=" + encodeURIComponent(S.sub.cat || "") + "&page=" + page;
    const r = await fetch(u, { headers: { accept: "application/json" } });
    let b = null; try { b = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok || !b || !b.ok) { const e = new Error("fail"); e.reason = b && b.reason; throw e; }
    return b;
  }

  async function load() {
    const my = ++run; clearTimeout(timer);
    S.state = "loading"; render();
    try {
      const b = await fetchPage(1); if (my !== run) return;
      Object.assign(S, { state: "ready", items: b.items, page: 1, hasMore: !!b.hasMore, stale: !!b.stale, fallback: !!b.fallback, country: b.country || "", expanded: false });
      render(); if (b.pending) poll(my, 0);
    } catch (e) { if (my !== run) return; S.state = "error"; S.reason = e.reason; render(); }
  }

  // Website links are looked up in the background. Ask again a few times so they appear without the person doing anything.
  function poll(my, n) {
    if (n >= 4) return;
    timer = setTimeout(async () => {
      if (my !== run) return;
      try {
        const bs = [];
        for (let p = 1; p <= S.page; p++) bs.push(await fetchPage(p));
        if (my !== run) return;
        S.items = bs.reduce((a, b) => merge(a, b.items), []);
        render();
        if (bs.some(b => b.pending)) poll(my, n + 1);
      } catch (e) { poll(my, n + 1); }
    }, n === 0 ? 6000 : 8000);
  }

  async function more() {
    const list = ordered(S.items);
    if (!S.expanded && list.length > SHORT) { S.expanded = true; render(); return; }
    S.expanded = true;
    if (!S.hasMore) { render(); return; }
    S.loadingMore = true; render();
    const my = run;
    try {
      const b = await fetchPage(S.page + 1); if (my !== run) return;
      S.items = merge(S.items, b.items); S.page += 1; S.hasMore = !!b.hasMore; S.loadingMore = false; render();
      if (b.pending) poll(my, 0);
    } catch (e) { S.loadingMore = false; S.hasMore = false; render(); }
  }

  window.Alternatives = {
    // sub: { name, cat }.  h: helpers from the app.
    show(sub, h) {
      H = h; S = { sub, state: "loading", items: [] };
      if (!h.cfg.altApi) { S.state = "error"; S.reason = "not_configured"; render(); return; }
      if (!H.el.dataset.bound) {
        H.el.dataset.bound = "1";
        H.el.addEventListener("click", e => {
          if (e.target.closest("#alt-more")) more();
          else if (e.target.closest("#alt-retry")) load();
        });
      }
      load();
    },
    stop() { run++; clearTimeout(timer); },
    _test: { ordered, freePlanText }
  };
})();
