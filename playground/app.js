// A minimal MCP client: JSON-RPC over Streamable HTTP (stateless server, JSON responses).
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (x) => `${Math.round(x * 100)}%`;
let rpcId = 0;

async function rpc(method, params) {
  const request = { jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) };
  const started = performance.now();
  const res = await fetch("mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(request),
  });
  const response = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  return { request, response, ms: Math.round(performance.now() - started) };
}

// Tools 7 and 8 never touch live data on this page.
const MODES = {
  search_console_report: "Fixture mode: no Search Console credentials are configured here, so the rows are sample data bundled with the server.",
  answer_engine_visibility: "Mock mode: no language model is called here. Replies come from a local stand-in, so the rates only demonstrate the statistics.",
};

const EXTRA = {
  check_crawler_access: `<label>Extra user-agents (comma-separated, optional) <input id="agents" placeholder="Bingbot, Applebot"></label>`,
  core_web_vitals: `<label>Strategy <select id="strategy"><option>mobile</option><option>desktop</option></select></label>`,
  crawl_site: `<label>Max pages (up to 30 here) <input id="maxPages" type="number" min="1" max="30" value="30"></label>`,
  search_console_report: `<div class="row"><label class="grow">Dimensions <select id="dims"><option value="query">query</option><option value="page">page</option><option value="query,page">query + page</option></select></label>
    <label>Rows <input id="rowLimit" type="number" min="1" max="50" value="10"></label></div>`,
  answer_engine_visibility: `<label>Prompts, one per line (up to 5) <textarea id="prompts"></textarea></label>
    <div class="row"><label>Runs per prompt <input id="runs" type="number" min="1" max="20" value="10"></label>
    <label class="grow">Baseline for the first prompt, as mentions/runs (optional) <input id="baseline" placeholder="2/10"></label></div>`,
};

const PROMPTS = {
  dental: "Which dentist on Bridge Road in Richmond can see a cracked tooth today?\nBest family dentist in Richmond, Melbourne",
  cafe: "Where can I buy freshly roasted coffee beans in Fitzroy?\nBest specialty coffee roaster near Gertrude Street",
  plumber: "Who can fix a burst pipe tonight in Northcote?\nEmergency plumber in Melbourne's inner north",
};

let clients = [];
let tools = [];

function args() {
  const tool = $("#tool").value, client = $("#client").value, a = { client };
  if (!["search_console_report", "answer_engine_visibility"].includes(tool)) a.url = $("#url").value.trim();
  if (tool === "check_crawler_access" && $("#agents").value.trim()) a.agents = $("#agents").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (tool === "core_web_vitals") a.strategy = $("#strategy").value;
  if (tool === "crawl_site") a.maxPages = Math.min(30, Number($("#maxPages").value) || 30);
  if (tool === "search_console_report") Object.assign(a, { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: $("#dims").value.split(","), rowLimit: Number($("#rowLimit").value) || 10 });
  if (tool === "answer_engine_visibility") {
    a.prompts = $("#prompts").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 5);
    a.runs = Number($("#runs").value) || 10;
    const m = $("#baseline").value.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (m && a.prompts[0]) a.baseline = [{ prompt: a.prompts[0], mentions: Number(m[1]), runs: Number(m[2]) }];
  }
  return a;
}

function refresh() {
  const tool = $("#tool").value;
  const c = clients.find((x) => x.id === $("#client").value);
  $("#desc").textContent = tools.find((t) => t.name === tool)?.description ?? "";
  $("#mode").hidden = !MODES[tool];
  $("#mode").textContent = MODES[tool] ?? "";
  $("#url-field").hidden = !!MODES[tool];
  $("#extra").innerHTML = EXTRA[tool] ?? "";
  if (tool === "answer_engine_visibility") $("#prompts").value = PROMPTS[c.id] ?? "";
}

function setClient() {
  const c = clients.find((x) => x.id === $("#client").value);
  if (!$("#url").value.startsWith(c.allow[0])) $("#url").value = c.allow[0];
  refresh();
}

// ------------------------------------------------------------------ result views

const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const chip = (cls, text = cls) => `<span class="chip ${esc(cls)}">${esc(text)}</span>`;
const stat = (label, value) => `<div class="stat"><b>${esc(value)}</b>${esc(label)}</div>`;
const list = (items, f = esc) => (items.length ? `<ul class="plain">${items.map((i) => `<li>${f(i)}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`);
const yes = (b) => chip(b ? "ok" : "bad", b ? "yes" : "no");

const VIEWS = {
  audit_page: (r) => `
    <div class="stats">${stat("errors", r.summary.errors)}${stat("warnings", r.summary.warnings)}${stat("internal links", r.links.internal)}${stat("images", r.images.total)}</div>
    <h3>Issues</h3>${r.issues.length ? table(["Severity", "Check", "Message"], r.issues.map((i) => `<tr><td>${chip(i.severity)}</td><td>${esc(i.check)}</td><td>${esc(i.message)}</td></tr>`)) : `<p class="muted">No issues.</p>`}
    <h3>Title and description</h3>${table(["Field", "Value", "Length"], [
      `<tr><td>title</td><td>${esc(r.title.text)}</td><td>${r.title.length}</td></tr>`,
      `<tr><td>meta description</td><td>${esc(r.metaDescription?.text ?? "(none)")}</td><td>${r.metaDescription?.length ?? 0}</td></tr>`,
      `<tr><td>canonical</td><td>${esc(r.canonical ?? "(none)")}</td><td></td></tr>`,
      `<tr><td>robots</td><td>${esc(r.robots ?? "(none)")}</td><td></td></tr>`])}
    <h3>Headings</h3><ul class="outline">${r.headings.map((h) => `<li style="margin-left:${(h.level - 1) * 18}px"><code>h${h.level}</code> ${esc(h.text)}</li>`).join("")}</ul>
    <h3>Open Graph</h3>${table(["Tag", "Value"], Object.entries(r.openGraph).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v ? esc(v) : chip("warning", "missing")}</td></tr>`))}`,

  validate_structured_data: (r) => `
    <div class="stats">${stat("JSON-LD blocks", r.blocks)}${stat("items checked", r.summary.items)}${stat("errors", r.summary.errors)}${stat("warnings", r.summary.warnings)}</div>
    ${r.parseErrors.length ? `<h3>Parse errors</h3>${list(r.parseErrors)}` : ""}
    <h3>Items</h3>${r.items.length ? table(["Type", "Checked as", "Errors", "Warnings"], r.items.map((i) => `<tr><td>${esc(i.type)}<br><span class="muted">${esc(i.at)}</span></td><td>${esc(i.checkedAs)}</td><td>${list(i.errors)}</td><td>${list(i.warnings)}</td></tr>`)) : `<p class="muted">No LocalBusiness, Service, FAQPage, Article or BreadcrumbList items found.</p>`}
    <p class="muted">Not checked: ${esc(r.uncheckedTypes.join(", ") || "none")}. ${esc(r.checks)}</p>`,

  check_crawler_access: (r) => `
    <p><b>robots.txt</b> ${esc(r.robots.url)} (HTTP ${r.robots.status || "none"}): ${esc(r.robots.note)}</p>
    ${r.subpathRobots ? `<p class="banner">${esc(r.subpathRobots.note)}</p>` : ""}
    ${table(["User-agent", `May fetch ${esc(r.path)}`, "Group used", "Deciding rule"], r.agents.map((a) => `<tr><td>${esc(a.agent)}</td><td>${yes(a.allowed)}</td><td>${esc(a.group ?? "(no rules)")}</td><td>${esc(a.rule ?? "no rule matches, so allowed")}</td></tr>`))}
    <h3>llms.txt</h3>${table(["URL", "Found", "Details"], r.llmsTxt.map((l) => `<tr><td>${esc(l.url)}</td><td>${yes(l.found)}</td><td>${l.found ? `${esc(l.title ?? "(no H1)")} · ${l.sections} sections · ${l.links} links · ${l.bytes} bytes` : `HTTP ${l.status || "none"}`}${l.problem ? ` · ${esc(l.problem)}` : ""}</td></tr>`))}`,

  core_web_vitals: (r) => {
    const f = (x) => (x ? table(["Metric", "p75", "Rating"], [["LCP", x.lcpMs, " ms"], ["INP", x.inpMs, " ms"], ["CLS", x.cls, ""]].map(([n, m, u]) => `<tr><td>${n}</td><td>${m ? esc(m.p75) + u : "n/a"}</td><td>${m ? chip(m.rating) : ""}</td></tr>`)) : `<p class="muted">No field data.</p>`);
    const l = r.lab;
    return `<h3>Field data (real Chrome users, 28 days)</h3><p class="muted">${esc(r.field.note)}</p><h3>This page</h3>${f(r.field.page)}<h3>Whole origin</h3>${f(r.field.origin)}
      <h3>Lab data (one Lighthouse run)</h3>${table(["Measure", "Value", "Rating"], [
        `<tr><td>Performance score</td><td>${esc(l.performanceScore ?? "n/a")}</td><td></td></tr>`,
        `<tr><td>LCP</td><td>${l.lcpMs ? `${l.lcpMs.value} ms` : "n/a"}</td><td>${l.lcpMs ? chip(l.lcpMs.rating) : ""}</td></tr>`,
        `<tr><td>CLS</td><td>${l.cls ? l.cls.value : "n/a"}</td><td>${l.cls ? chip(l.cls.rating) : ""}</td></tr>`,
        `<tr><td>Total blocking time</td><td>${esc(l.totalBlockingTimeMs ?? "n/a")} ms</td><td></td></tr>`])}<p class="muted">${esc(l.note)}</p>`;
  },

  crawl_site: (r) => `
    <div class="stats">${stat("pages fetched", r.pagesFetched)}${stat("broken", r.broken.length)}${stat("orphans", r.orphans.length)}${stat("sitemap URLs", r.sitemap.urlsInScope)}${stat("redirects", r.redirects.length)}</div>
    <p class="muted">${esc(r.notes.join(" "))} Rate limit: ${r.limits.requestsPerSecondPerHost} requests per second per host.</p>
    <h3>Broken links</h3>${list(r.broken, (b) => `${esc(b.url)} ${chip("error", b.status ?? "failed")} ${b.linkedFrom.length ? `<span class="muted">linked from ${esc(b.linkedFrom.join(", "))}</span>` : ""}`)}
    <h3>Orphan pages</h3>${list(r.orphans)}
    <h3>Duplicate titles</h3>${list(r.duplicateTitles, (d) => `“${esc(d.text)}” on ${esc(d.urls.join(", "))}`)}
    <h3>Duplicate meta descriptions</h3>${list(r.duplicateDescriptions, (d) => `“${esc(d.text)}” on ${esc(d.urls.join(", "))}`)}
    <h3>Redirects</h3>${list(r.redirects, (d) => `${esc(d.from)} → ${esc(d.to)} (${esc(d.status)})`)}
    <h3>Sitemaps read</h3>${table(["File", "HTTP", "URLs", "In scope"], r.sitemap.files.map((f) => `<tr><td>${esc(f.url)}</td><td>${f.status || esc(f.error)}</td><td>${f.urls}</td><td>${f.inScope}</td></tr>`))}`,

  score_answerability: (r) => {
    const c = r.components, bar = (p, max) => `<div class="bar"><i style="width:${(p / max) * 100}%"></i></div>`;
    return `<div class="stats">${stat("answerability score", `${r.score}/100`)}</div>
      ${table(["Component", "Points", "", "Measured"], [
        `<tr><td>Question headings</td><td>${c.questionHeadings.points}/25</td><td>${bar(c.questionHeadings.points, 25)}</td><td>${c.questionHeadings.questions} of ${c.questionHeadings.subheadings} subheadings are questions</td></tr>`,
        `<tr><td>Answer first</td><td>${c.answerFirst.points}/35</td><td>${bar(c.answerFirst.points, 35)}</td><td>${c.answerFirst.passed} of ${c.answerFirst.checked} sections open with a short answer</td></tr>`,
        `<tr><td>FAQ markup</td><td>${c.faqMarkup.points}/15</td><td>${bar(c.faqMarkup.points, 15)}</td><td>${c.faqMarkup.questions} FAQPage questions, ${c.faqMarkup.visibleOnPage} visible on the page</td></tr>`,
        `<tr><td>Paragraph length</td><td>${c.paragraphLength.points}/25</td><td>${bar(c.paragraphLength.points, 25)}</td><td>${c.paragraphLength.overLimit} of ${c.paragraphLength.paragraphs} paragraphs over 80 words</td></tr>`])}
      <h3>Sections checked</h3>${table(["Heading", "Answer first", "First sentence", "Why not"], c.answerFirst.sections.map((s) => `<tr><td>${esc(s.heading)}</td><td>${yes(s.pass)}</td><td>${s.firstSentenceWords} words</td><td>${esc(s.reason ?? "")}</td></tr>`))}
      <h3>Suggestions</h3>${list(r.suggestions, (s) => `<b>${esc(s.heading)}</b>: ${esc(s.suggestion)}`)}
      <p class="muted">${esc(r.method)}</p>`;
  },

  search_console_report: (r) => `
    <p class="banner">${esc(r.notice ?? `Live data for ${r.property}`)}</p>
    ${table([...r.dimensions, "Clicks", "Impressions", "CTR", "Avg position"], r.rows.map((x) => `<tr>${x.keys.map((k) => `<td>${esc(k)}</td>`).join("")}<td>${x.clicks}</td><td>${x.impressions}</td><td>${pct(x.ctr)}</td><td>${x.position.toFixed(1)}</td></tr>`))}`,

  answer_engine_visibility: (r) => `
    ${r.notice ? `<p class="banner">${esc(r.notice)}</p>` : ""}
    <div class="stats">${stat("mention rate, all runs", pct(r.overall.rate))}${stat("95% interval", `${pct(r.overall.ci95[0])}–${pct(r.overall.ci95[1])}`)}${stat("runs", r.overall.runs)}</div>
    ${table(["Prompt", "Mentions", "Rate (95% interval)", "Against baseline"], r.prompts.map((p) => `<tr><td>${esc(p.prompt)}</td><td>${p.mentions}/${p.runs}</td><td>${pct(p.rate)} (${pct(p.ci95[0])}–${pct(p.ci95[1])})</td><td>${p.change ? `${p.baseline.mentions}/${p.baseline.runs} → ${p.mentions}/${p.runs}: ${esc(p.change.verdict)}` : `<span class="muted">no baseline</span>`}</td></tr>`))}
    <p class="muted">Brand terms: ${esc(r.brandTerms.join(", "))}. ${esc(r.method)}</p>`,
};

function render(tool, { request, response, ms }) {
  const result = response.result;
  let body;
  if (response.error) body = `<p class="error">${esc(response.error.message)}</p>`;
  else if (result.isError) body = `<p class="error">${esc(result.content?.[0]?.text)}</p>`;
  else body = VIEWS[tool](result.structuredContent);
  $("#out").innerHTML = `<div class="card"><h2>${esc(tool)} <span class="muted">· ${ms} ms</span></h2>${body}
    <details><summary>JSON-RPC request</summary><pre>${esc(JSON.stringify(request, null, 2))}</pre></details>
    <details><summary>JSON-RPC response</summary><pre>${esc(JSON.stringify(response, null, 2))}</pre></details>
    ${result?.content ? `<details><summary>Text a model client would read (untrusted data fenced)</summary><pre>${esc(result.content[0].text)}</pre></details>` : ""}</div>`;
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tool = $("#tool").value;
  $("#run").disabled = true;
  $("#out").innerHTML = `<div class="card muted">Running ${esc(tool)}${tool === "crawl_site" ? " (a polite crawl takes 10 to 20 seconds)" : tool === "core_web_vitals" ? " (Google's Lighthouse run can take 30 seconds)" : ""}…</div>`;
  try {
    render(tool, await rpc("tools/call", { name: tool, arguments: args() }));
  } catch (err) {
    $("#out").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $("#run").disabled = false;
  }
});

const [clientList, listed] = await Promise.all([fetch("clients").then((r) => r.json()), rpc("tools/list")]);
clients = clientList;
tools = listed.response.result.tools;
$("#client").innerHTML = clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
$("#tool").innerHTML = tools.map((t) => `<option value="${esc(t.name)}">${esc(t.title)}${MODES[t.name] ? (t.name === "search_console_report" ? " (fixture)" : " (mock)") : ""}</option>`).join("");
$("#client").addEventListener("change", setClient);
$("#tool").addEventListener("change", setClient);
setClient();
