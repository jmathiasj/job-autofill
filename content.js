// In-page brain. Runs on the application page you're looking at.
// Deterministic fields fill from your profile; free-text drafts from your resume
// (via the background LLM call); your edits train the answer bank. You submit.

try { document.documentElement.dataset.aaLoaded = "1"; } catch (e) {}
// Resilient messaging: after the extension is reloaded, the old content script
// is orphaned and chrome.runtime calls throw "Extension context invalidated".
// Resolve null instead of crashing; callers tell the user to refresh.
const send = (msg) => new Promise((res) => {
  try {
    chrome.runtime.sendMessage(msg, (r) => {
      try { void chrome.runtime.lastError; } catch (e) {}
      res(r === undefined ? null : r);
    });
  } catch (e) { res(null); }
});
const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

// ---------- shadow-DOM-aware queries ----------
// SuccessFactors / Oracle / web-component ATSes render fields inside shadow
// roots that document.querySelectorAll can't see. Collect every open root
// (cached briefly - the walk is O(page size)) and search them all.
let _roots = null, _rootsTs = 0;
function collectRoots() {
  const now = Date.now();
  if (_roots && now - _rootsTs < 400) return _roots;
  const roots = [document];
  const walk = (root) => {
    let els; try { els = root.querySelectorAll("*"); } catch (e) { return; }
    for (const el of els) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
  };
  walk(document);
  _roots = roots; _rootsTs = now;
  return roots;
}
function deepQSA(sel) {
  const out = [];
  for (const r of collectRoots()) { try { out.push(...r.querySelectorAll(sel)); } catch (e) {} }
  return out;
}
function byAaId(id) {
  for (const r of collectRoots()) { const el = r.querySelector('[data-aa-id="' + id + '"]'); if (el) return el; }
  return null;
}

// ---------- text helpers ----------
const STOP = new Set("the a an of to and or in on for your you please do are is will with this that we us our if any have has be at as by it".split(" "));
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((t) => t && !STOP.has(t)));
function jaccard(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let i = 0; A.forEach((t) => B.has(t) && i++); return i / (A.size + B.size - i);
}

// ---------- profile mapping (ported from the Python resolver) ----------
const LABEL_RULES = [
  [/first\s*name/, "identity.first_name"],
  [/last\s*name|surname|family\s*name/, "identity.last_name"],
  [/preferred\s*name/, "identity.first_name"],
  [/full\s*name|legal\s*name|^name$|your\s*name/, "identity.full_name"],
  [/e[-\s]?mail/, "identity.email"],
  [/phone|mobile|cell/, "identity.phone"],
  [/linked/, "links.linkedin"],
  [/git\s*hub/, "links.github"],
  [/portfolio/, "links.portfolio"],
  [/website|personal\s*site/, "links.website"],
  [/authoriz|eligible\s+to\s+work|legally\s+(?:able|allowed)\s+to\s+work/, "work_eligibility.authorized_to_work_us"],
  [/sponsor/, "work_eligibility.require_sponsorship_now_or_future"],
  [/\bvisa\b|immigration\s*status/, "work_eligibility.visa_status"],
  [/citizen/, "work_eligibility.citizenship"],
  [/clearance/, "work_eligibility.security_clearance"],
  [/gender|^sex$/, "eeo_voluntary.gender"],
  [/race|ethnic/, "eeo_voluntary.race_ethnicity"],
  [/veteran/, "eeo_voluntary.veteran_status"],
  [/disab/, "eeo_voluntary.disability_status"],
  [/years.*experience|experience.*years/, "logistics.years_experience"],
  [/reloc/, "logistics.open_to_relocation"],
  [/remote|on[-\s]?site|hybrid/, "logistics.remote_preference"],
  [/start\s*date|available/, "logistics.earliest_start_date"],
  [/notice\s*period/, "logistics.notice_period"],
  [/salary|compensation|desired\s*pay|pay\s*expect/, "logistics.salary_expectation"],
  [/zip|postal/, "identity.zip_code"],
  [/\bcity\b|location/, "identity.location_city"],
  [/\bstate\b|province/, "identity.location_state"],
  [/\bcountry\b/, "identity.country"],
];
const SENSITIVE = [/sponsor/, /authoriz/, /eligible\s+to\s+work/, /\bvisa\b/, /citizen/, /salary|compensation|pay\s*expect/, /gender|\bsex\b/, /race|ethnic/, /veteran/, /disab/, /\bage\b|date\s*of\s*birth/, /\bai\b|artificial\s*intelligence|chatgpt|\bllm\b|language\s*model|did\s*you\s*use|generative/, /certif|attest|acknowledg|i\s*agree|consent|signature|esign/, /felony|convict|background\s*check|criminal/];
const FREETEXT = ["why", "describe", "tell us", "what", "how", "experience with", "cover letter", "passionate", "interest"];
const isSensitive = (l) => SENSITIVE.some((r) => r.test((l || "").toLowerCase()));
const isFreetext = (f) => f.type === "textarea" || (f.type === "text" && FREETEXT.some((h) => f.label.toLowerCase().includes(h)));

function getByPath(o, p) {
  return p.split(".").reduce((n, k) => {
    if (n == null) return null;
    return Array.isArray(n) ? n[parseInt(k)] : n[k];
  }, o);
}
const isPlaceholder = (v) => /^\s*(todo_confirm|see\s|assemble\s)/i.test(String(v));
function valueForLabel(profile, label) {
  const L = (label || "").toLowerCase();
  for (const [rx, key] of LABEL_RULES) if (rx.test(L)) {
    const v = getByPath(profile, key);
    if (v == null || isPlaceholder(v)) return [null, key];
    return [String(v), key];
  }
  return [null, null];
}
function closestOption(value, options) {
  if (!options || !options.length) return value;
  const v = norm(value); if (!v) return null;
  const pairs = options.map((o) => [o, norm(o)]);
  for (const [o, n] of pairs) if (n && n === v) return o;
  // containment only when the shorter side is a real word ("no" must never match "norway")
  for (const [o, n] of pairs) if (n && Math.min(v.length, n.length) >= 4 && (v.includes(n) || n.includes(v))) return o;
  let best = null, s = 0; for (const [o, n] of pairs) { if (!n) continue; const j = jaccard(value, o); if (j > s) { best = o; s = j; } }
  return s >= 0.45 ? best : null; // weak fuzzy matches are a wrong-fill risk - prefer leaving it blank
}
// Shared choice matcher for radios / button groups / custom dropdowns:
// exact (normalized) -> word-boundary prefix -> containment only for values >= 4 chars.
function matchChoice(value, items, getText) {
  const v = norm(value); if (!v) return null;
  let m = items.find((it) => norm(getText(it)) === v);
  if (m) return m;
  m = items.find((it) => { const t = norm(getText(it)); return t && (t.startsWith(v + " ") || v.startsWith(t + " ")); });
  if (m) return m;
  if (v.length >= 4) {
    m = items.find((it) => { const t = norm(getText(it)); return t && (t.includes(v) || v.includes(t)); });
    if (m) return m;
  }
  return null;
}

// ---------- ATS detection ----------
function detectATS() {
  const h = location.host;
  if (h.includes("greenhouse.io")) return "greenhouse";
  if (h.includes("lever.co")) return "lever";
  if (h.includes("ashbyhq.com")) return "ashby";
  if (h.includes("myworkdayjobs.com")) return "workday";
  if (h.includes("icims.com")) return "icims";
  if (h.includes("smartrecruiters.com")) return "smartrecruiters";
  if (h.includes("workable.com")) return "workable";
  if (h.includes("jobvite.com")) return "jobvite";
  if (h.includes("bamboohr.com")) return "bamboohr";
  if (h.includes("taleo.net")) return "taleo";
  return null;
}
const ASHBY_SYS = { _systemfield_name: "Full Name", _systemfield_email: "Email", _systemfield_phoneNumber: "Phone", _systemfield_phone: "Phone", _systemfield_resume: "Resume" };

// ---------- job description extraction (for tailored "why" answers) ----------
let CURRENT_JD = null;
let CURRENT_BANK = {};
// Your previously-typed answers, ranked by relevance to a new question.
// This is how "training on what you input" reaches the LLM: it reads the new
// question and adapts your closest prior answers.
function topBank(label, k) {
  return Object.values(CURRENT_BANK)
    .filter((e) => e && e.value)
    .map((e) => ({ q: e.label || "", a: e.value, s: jaccard(label, e.label || "") }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((e) => ({ q: e.q, a: e.a }));
}
function getCompany() {
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og && og.content) return og.content.trim();
  // greenhouse embeds carry the company in ?for= (path would say "embed")
  try { const f = new URL(location.href).searchParams.get("for"); if (f) return cap(f); } catch (e) {}
  const path = location.pathname.split("/").filter(Boolean);
  const h = location.host;
  if (h.includes("ashbyhq") || h.includes("lever.co") || h.includes("greenhouse.io")) {
    const skip = new Set(["embed", "job_app", "jobs", "job", "boards", "apply", "application", "internal"]);
    const seg = path.find((s) => !skip.has(s.toLowerCase()));
    return cap(seg || "");
  }
  if (h.includes("myworkdayjobs")) return cap(h.split(".")[0] || "");
  return (document.title.split(/[-|@]/).pop() || "").trim();
}
function extractJD() {
  const company = getCompany();
  const h1 = document.querySelector("h1");
  const title = ((h1 && h1.innerText) || document.title || "").trim().slice(0, 160);
  // pick the RICHEST candidate text block; fall back to body if all are thin
  let best = "";
  for (const sel of ["[class*=escription]", "[class*=obDescription]", "[class*=osting]", "[class*=ontent]", "article", "main"]) {
    document.querySelectorAll(sel).forEach((el) => {
      const t = (el.innerText || "").trim();
      if (t.length > best.length) best = t;
    });
  }
  if (best.length < 400) best = (document.body.innerText || "").trim();
  return { company, title, description: best.replace(/\s+/g, " ").slice(0, 5000) };
}

// ---------- enumerate ----------
function labelFor(el) {
  const root = (el.getRootNode && el.getRootNode()) || document;
  if (el.id) { let l = null; try { l = root.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) {} if (l && l.innerText.trim()) return l.innerText.trim(); }
  const wrap = el.closest("label"); if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
  const lb = el.getAttribute("aria-labelledby");
  if (lb) { const t = lb.split(/\s+/).map((id) => { const n = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id); return n ? n.innerText : ""; }).join(" ").trim(); if (t) return t; }
  const fw = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
  if (fw) { const l = fw.querySelector("label,.label"); if (l && l.innerText.trim()) return l.innerText.trim(); }
  // Workday/iCIMS name their controls via data-automation-id; humanize it as a fallback
  const aid = el.getAttribute("data-automation-id");
  if (aid) { const t = aid.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b(input|section|field)\b/gi, " ").replace(/\s+/g, " ").trim(); if (t) return t; }
  return el.getAttribute("placeholder") || el.name || "";
}
// Workday repeating sections (Work Experience 1/2/…, Education 1/…): resolve the
// numbered panel a field sits in, so identical labels ("Company", "Degree") become
// unambiguous for the mapper: "Work Experience 2 - Company".
function sectionContext(el) {
  if (detectATS() !== "workday") return "";
  let n = el.parentElement;
  for (let k = 0; k < 14 && n; k++, n = n.parentElement) {
    const aid = (n.getAttribute && n.getAttribute("data-automation-id")) || "";
    let m = aid.match(/^([a-zA-Z]+)-(\d+)$/);
    if (m) return m[1].replace(/([a-z])([A-Z])/g, "$1 $2") + " " + m[2];
    const lb = n.getAttribute && n.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.innerText : ""; }).join(" ").replace(/\s+/g, " ").trim();
      if (/^[a-z][a-z\s]*\d+$/i.test(t) && t.length < 40) return t;
    }
  }
  return "";
}
function withSection(el, label) {
  const ctx = sectionContext(el);
  if (!ctx || !label) return label;
  if (label.toLowerCase().includes(ctx.toLowerCase())) return label;
  return ctx + " - " + label;
}
// Field ids must be globally unique across enumeration passes. The periodic
// harvest re-enumerates while a fill can be in flight - if ids restarted at 0
// each pass, an in-flight "aa-12" could suddenly point at a DIFFERENT element
// (the source of "Illegal invocation" fill failures).
let AA_SEQ = 0;
function enumerate() {
  const out = []; let fileSeen = 0;
  const allInputs = deepQSA("input,textarea,select");
  const fileCount = allInputs.filter((el) => el.type === "file").length;
  allInputs.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text").toLowerCase() : tag;
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return;
    if (el.disabled) return;
    if (el.closest("[class*=select__control],[class*=-control]")) return; // react-select internal input
    const st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") { if (type !== "file") return; }
    if (type === "radio" && out.find((o) => o.type === "radio" && o.name === el.name)) return;
    const id = "aa-" + AA_SEQ++; el.setAttribute("data-aa-id", id);
    const root = (el.getRootNode && el.getRootNode()) || document;
    let options = [];
    if (tag === "select") options = [...el.options].map((o) => o.text.trim()).filter(Boolean);
    else if (type === "radio") options = [...root.querySelectorAll('input[type=radio][name="' + CSS.escape(el.name) + '"]')].map(labelFor).filter(Boolean);
    const rawLabel = (labelFor(el) || "").replace(/\s+/g, " ").trim();
    const star = /\*\s*$/.test(rawLabel); // ATSes mark required fields with a trailing asterisk
    let label = rawLabel.replace(/\*$/, "").trim();
    if (type === "radio") {
      // label a radio GROUP by its question (legend / field label), not the first option
      const scope = el.closest("fieldset") || el.closest("[class*=field],[class*=Field],[class*=question],[class*=Question]");
      if (scope) {
        let q = "";
        const lg = scope.querySelector("legend");
        if (lg && lg.innerText.trim()) q = lg.innerText.trim();
        if (!q) { for (const c of scope.querySelectorAll("label,[class*=label],[class*=Label]")) { if (c.querySelector("input")) continue; const t = (c.innerText || "").trim(); if (t) { q = t; break; } } }
        if (q) label = q.replace(/\s+/g, " ").replace(/\*$/, "").trim();
      }
    }
    if (el.name in ASHBY_SYS) label = ASHBY_SYS[el.name];
    if (type === "file") {
      const hay = (label + " " + (el.name || "") + " " + (el.id || "")).toLowerCase();
      if (/cover/.test(hay)) label = "Cover Letter";
      else if (/resume|\bcv\b|curriculum/.test(hay)) label = "Resume";
      else if (!label && fileCount === 1) label = "Resume"; // lone file field = resume
      else if (!label) label = "Additional Attachment"; // ambiguous + multiple -> leave to you, never guess
      fileSeen++;
    }
    if (!label || ["search", "type here..."].includes(label.toLowerCase())) return;
    label = withSection(el, label);
    out.push({ id, label, type, name: el.name || "", options, required: el.required || el.getAttribute("aria-required") === "true" || star });
  });
  // Custom <button> option groups (Ashby renders Yes/No as separate buttons).
  // Group by the question wrapper = nearest ancestor that contains a <label>.
  const optBtns = deepQSA('button[class*=option],button[class*=Option]').filter((b) => getComputedStyle(b).display !== "none");
  const usedBtns = new Set();
  optBtns.forEach((btn) => {
    if (usedBtns.has(btn)) return;
    let anc = btn.parentElement;
    for (let k = 0; k < 6 && anc; k++) { if (anc.querySelector("label")) break; anc = anc.parentElement; }
    if (!anc) anc = btn.parentElement;
    const group = optBtns.filter((b) => anc.contains(b) && !usedBtns.has(b));
    group.forEach((b) => usedBtns.add(b));
    const l = anc.querySelector("label");
    const rawBL = ((l && l.innerText) || "").replace(/\s+/g, " ").trim();
    const label = rawBL.replace(/\*$/, "").trim();
    if (!label || !group.length) return;
    const id = "aa-" + AA_SEQ++; anc.setAttribute("data-aa-id", id);
    out.push({ id, label, type: "buttons", name: "", options: group.map((b) => b.innerText.trim()).filter(Boolean), required: /\*\s*$/.test(rawBL) });
  });
  // Custom "Select..." dropdowns (react-select): target the control, resolve label robustly.
  const seenSel = new Set();
  const selCtrls = deepQSA("[class*=select__control],[class*=-control]");
  [...document.querySelectorAll("div,span")].forEach((el) => { if (!el.children.length && /^select\.{2,3}$/i.test((el.textContent || "").trim())) { const c = el.closest("[class*=control]"); if (c) selCtrls.push(c); } });
  selCtrls.forEach((ctrl) => {
    if (seenSel.has(ctrl)) return; // dedupe within this call only (re-enumeration must re-detect)
    seenSel.add(ctrl);
    let label = "";
    const sroot = (ctrl.getRootNode && ctrl.getRootNode()) || document;
    const inp = ctrl.querySelector("input");
    if (inp && inp.getAttribute("aria-labelledby")) { const t = inp.getAttribute("aria-labelledby").split(/\s+/).map((id) => { const nn = (sroot.getElementById ? sroot.getElementById(id) : null) || document.getElementById(id); return nn ? nn.innerText : ""; }).join(" ").trim(); if (t) label = t; }
    if (!label && inp && inp.id) { let l = null; try { l = sroot.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); } catch (e) {} if (l && l.innerText.trim()) label = l.innerText.trim(); }
    if (!label) { let n = ctrl; for (let k = 0; k < 12 && n; k++) { const d = [...n.children].find((c) => c.tagName === "LABEL" && c.innerText.trim()); if (d) { label = d.innerText.trim(); break; } n = n.parentElement; } }
    const rawSL = (label || "").replace(/\s+/g, " ").trim();
    label = rawSL.replace(/\*$/, "").trim();
    if (!label) return;
    const id = "aa-" + AA_SEQ++; ctrl.setAttribute("data-aa-id", id);
    out.push({ id, label, type: "customselect", name: "", options: [], required: /\*\s*$/.test(rawSL) });
  });
  // Workday-style dropdowns: <button aria-haspopup="listbox">. Options render in
  // a portal at the document root, so they're read on demand (readWdOptions).
  deepQSA('button[aria-haspopup="listbox"]').forEach((btn) => {
    if (btn.hasAttribute("data-aa-id") || btn.closest("[data-aa-id]")) return;
    const st = getComputedStyle(btn); if (st.display === "none" || st.visibility === "hidden") return;
    const rawWL = (labelFor(btn) || "").replace(/\s+/g, " ").trim();
    let label = rawWL.replace(/\*$/, "").trim();
    if (!label) return;
    label = withSection(btn, label);
    const id = "aa-" + AA_SEQ++; btn.setAttribute("data-aa-id", id);
    out.push({ id, label, type: "wdlistbox", name: btn.getAttribute("data-automation-id") || "", options: [], required: /\*\s*$/.test(rawWL) });
  });
  return out;
}

// ---------- fill ----------
function setNative(el, value) {
  try { el.focus(); } catch (e) {}
  // find the native value setter on EL'S OWN prototype chain - hardcoding
  // HTMLInputElement.prototype throws "Illegal invocation" if el turns out to
  // be a select/div/button or lives in another realm
  let done = false;
  try {
    for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) { d.set.call(el, value); done = true; break; }
    }
  } catch (e) {}
  if (!done) { try { el.value = value; } catch (e) {} }
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true })); // some frameworks commit the value on blur
  } catch (e) {}
}
function dataURLtoFile(dataurl, filename) {
  const [meta, b64] = dataurl.split(","); const mime = (meta.match(/:(.*?);/) || [])[1] || "application/pdf";
  const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], filename, { type: mime });
}
function attachFileToInput(el, file) {
  const dt = new DataTransfer(); dt.items.add(file);
  try { el.files = dt.files; } catch (e) {}
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {}
  // custom dropzone uploaders (Ashby/Workday) listen for drop, not input.files
  const zone = el.closest("[class*=rop],[class*=pload],[class*=ile],form") || el.parentElement;
  if (zone) ["dragenter", "dragover", "drop"].forEach((type) => {
    const d = new DataTransfer(); d.items.add(file);
    try { zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: d })); } catch (e) {}
  });
}
async function fillFile(el, kind) {
  const doc = await send({ type: "getDoc", kind, variant: window.__aaVariant || "systems" });
  if (!doc || !doc.dataUrl) return;
  attachFileToInput(el, dataURLtoFile(doc.dataUrl, doc.name));
}

// Minimal in-browser PDF writer (Helvetica 11pt, US Letter, 1in margins) for
// tailored cover letters - text-only, no external libraries.
function textToPdfDataUrl(text) {
  const escPdf = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const clean = String(text || "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/\r/g, "").replace(/[^\x20-\x7E\n]/g, "");
  const lines = [];
  for (const para of clean.split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    let cur = "";
    for (const w of para.split(/\s+/)) {
      if ((cur + " " + w).trim().length > 92) { lines.push(cur.trim()); cur = w; }
      else cur = cur + " " + w;
    }
    if (cur.trim()) lines.push(cur.trim());
  }
  const perPage = 48;
  const pages = [];
  for (let i = 0; i < lines.length || !pages.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  const objs = [];
  const pageNums = pages.map((_, i) => 4 + 2 * i);
  objs[0] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objs[1] = `2 0 obj\n<< /Type /Pages /Kids [${pageNums.map((n) => n + " 0 R").join(" ")}] /Count ${pages.length} >>\nendobj\n`;
  objs[2] = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  pages.forEach((pg, i) => {
    let stream = "BT\n/F1 11 Tf\n13 TL\n72 720 Td\n";
    for (const ln of pg) stream += `(${escPdf(ln)}) Tj\nT*\n`;
    stream += "ET";
    const pn = pageNums[i], cn = pn + 1;
    objs[pn - 1] = `${pn} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cn} 0 R >>\nendobj\n`;
    objs[cn - 1] = `${cn} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return "data:application/pdf;base64," + btoa(pdf);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isCombobox(el) {
  return el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox" || !!el.getAttribute("aria-autocomplete");
}
// Typeahead/autocomplete (e.g. Ashby Location): type, wait for the listbox, click a match.
async function fillCombobox(el, value) {
  const city = (value.split(",")[0] || value).trim();
  const want = city.toLowerCase();
  el.focus();
  setNative(el, city);
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  for (let i = 0; i < 26; i++) {
    await sleep(150);
    // scope to THIS combobox's listbox so we never click another widget's options
    const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    const root = (el.getRootNode && el.getRootNode()) || document;
    const scope = (listId && ((root.getElementById && root.getElementById(listId)) || document.getElementById(listId))) || null;
    const opts = (scope ? [...scope.querySelectorAll("[role=option]")] : deepQSA("[role=option]")).filter((o) => o.offsetParent !== null && o.innerText.trim());
    const match = opts.find((o) => o.innerText.toLowerCase().includes(want));
    if (match) { match.scrollIntoView({ block: "center" }); match.click(); el.dispatchEvent(new Event("change", { bubbles: true })); return true; }
  }
  return false; // no matching suggestion -> leave for you, never mis-click
}
// Custom "Select..." dropdown (Greenhouse react-select): click to open, click a matching option.
const mouseSeq = (el) => ["mousedown", "mouseup", "click"].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
// react-select (Greenhouse/Stripe) opens via focus + ArrowDown, NOT mousedown.
function openSelect(ctrl) {
  const inp = ctrl.querySelector("input");
  if (inp) { try { inp.focus(); } catch (e) {} inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, keyCode: 40 })); }
  else mouseSeq(ctrl);
}
// only the OPEN menu's options (avoid matching unrelated "option" classes on the page)
function visibleOptions() {
  return deepQSA('[class*=select__option],[role=option],[class*=menu] [class*=option]')
    .filter((o) => o.offsetParent !== null && o.innerText.trim() && o.querySelectorAll("input,select").length === 0);
}
async function readSelectOptions(ctrl) {
  if (!ctrl) return [];
  openSelect(ctrl);
  let opts = [];
  for (let i = 0; i < 14; i++) { await sleep(100); if (!opts.length && i === 4) mouseSeq(ctrl); const v = visibleOptions(); if (v.length) { opts = v.map((o) => o.innerText.trim()); break; } }
  const inp = ctrl.querySelector("input"); if (inp) inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ctrl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return [...new Set(opts)].filter(Boolean).slice(0, 25);
}
// Workday listbox: options portal to the document root as [role=option]
function wdVisibleOptions() {
  return deepQSA("[role=listbox] [role=option], ul[role=listbox] li")
    .filter((o) => o.offsetParent !== null && o.innerText.trim());
}
async function readWdOptions(btn) {
  if (!btn) return [];
  btn.scrollIntoView({ block: "center" });
  btn.click();
  let opts = [];
  for (let i = 0; i < 14; i++) {
    await sleep(120);
    const v = wdVisibleOptions();
    if (v.length) { opts = v.map((o) => o.innerText.trim()); break; }
  }
  btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return [...new Set(opts)].filter(Boolean).slice(0, 40);
}
async function fillWdListbox(btn, value) {
  btn.scrollIntoView({ block: "center" });
  btn.click();
  for (let i = 0; i < 20; i++) {
    await sleep(120);
    const opts = wdVisibleOptions();
    const match = matchChoice(value, opts, (o) => o.innerText);
    if (match) { match.scrollIntoView({ block: "center" }); match.click(); return true; }
    if (opts.length && i > 8) break; // options visible but nothing matches -> leave to the human
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return false;
}
async function fillCustomSelect(ctrl, value) {
  ctrl.scrollIntoView({ block: "center" });
  openSelect(ctrl);
  for (let i = 0; i < 24; i++) {
    await sleep(120);
    const opts = visibleOptions();
    if (!opts.length && i === 4) mouseSeq(ctrl); // fallback open
    const match = matchChoice(value, opts, (o) => o.innerText);
    if (match) { match.scrollIntoView({ block: "center" }); mouseSeq(match); return true; }
    if (opts.length && i > 8) break;
  }
  return false;
}
async function fillField(f, value) {
  const el = byAaId(f.id); if (!el) return;
  if (f.type === "select") { const opt = closestOption(value, f.options) || value; const m = [...el.options].find((o) => o.text.trim() === opt); if (m) { el.value = m.value; el.dispatchEvent(new Event("change", { bubbles: true })); } }
  else if (f.type === "checkbox") { el.checked = /^(yes|true|1|on)$/i.test(value); el.dispatchEvent(new Event("change", { bubbles: true })); }
  else if (f.type === "radio") { const root = (el.getRootNode && el.getRootNode()) || document; const g = [...root.querySelectorAll('input[type=radio][name="' + CSS.escape(f.name) + '"]')]; const pick = matchChoice(value, g, labelFor); if (pick) pick.click(); }
  else if (f.type === "file") { const l = f.label.toLowerCase(); if (/cover/.test(l)) await fillFile(el, "cover_letter"); else if (/resume|\bcv\b|curriculum/.test(l)) await fillFile(el, "resume"); }
  else if (f.type === "buttons") { const btns = [...el.querySelectorAll("button")]; const pick = matchChoice(value, btns, (b) => b.innerText); if (pick) pick.click(); }
  else if (f.type === "customselect") { await fillCustomSelect(el, value); }
  else if (f.type === "wdlistbox") { await fillWdListbox(el, value); }
  else {
    // Workday splits dates into separate Month/Day/Year spinbutton inputs while
    // values arrive as MM/YYYY or M/D/YYYY - feed each segment its own part
    const aid = el.getAttribute("data-automation-id") || "";
    const my = value.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
    const mdy = value.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})$/);
    let v = value;
    if (/month/i.test(aid)) v = my ? my[1] : mdy ? mdy[1] : v;
    else if (/year/i.test(aid)) v = my ? my[2] : mdy ? mdy[3] : v;
    else if (/day/i.test(aid) && mdy) v = mdy[2];
    if (isCombobox(el)) await fillCombobox(el, v);
    else setNative(el, v);
  }
}

// ---------- autonomous learning ----------
// Capture the CURRENT value of every field (whatever you ended up with, typed or
// edited) into the answer bank. Runs on a timer and on page-leave, so it learns
// on its own with no action from you.
function readValue(f) {
  const el = byAaId(f.id); if (!el) return "";
  if (f.type === "select") return el.value ? (el.options[el.selectedIndex] || {}).text || "" : "";
  if (f.type === "radio") { const root = (el.getRootNode && el.getRootNode()) || document; const g = root.querySelectorAll('input[type=radio][name="' + CSS.escape(f.name) + '"]'); for (const r of g) if (r.checked) return labelFor(r); return ""; }
  if (f.type === "checkbox") return el.checked ? "Yes" : "";
  if (f.type === "buttons") { const b = [...el.querySelectorAll("button")].find((x) => x.getAttribute("aria-pressed") === "true" || x.getAttribute("aria-checked") === "true" || /(_selected|selected|active)/.test(x.className)); return b ? b.innerText.trim() : ""; }
  if (f.type === "wdlistbox") { const t = (el.innerText || "").replace(/\s+/g, " ").trim(); return /^select(\s*one)?\.{0,3}$/i.test(t) ? "" : t; }
  if (f.type === "customselect") {
    const sv = el.querySelector("[class*=single-value],[class*=singleValue]");
    if (sv && sv.innerText.trim()) return sv.innerText.trim();
    const mv = [...el.querySelectorAll("[class*=multi-value__label],[class*=multi-value],[class*=multiValue]")].map((x) => x.innerText.trim()).filter(Boolean);
    if (mv.length) return mv.join(", ");
    const inp = el.querySelector("input"); if (inp && inp.value && inp.value.trim()) return inp.value.trim();
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    return /^select\.{0,3}$/i.test(t) ? "" : t; // any non-placeholder text = filled
  }
  return el.value || "";
}
function harvestAll(fields) {
  for (const f of fields) {
    if (f.type === "file") continue;
    const v = readValue(f);
    if (v && v.trim()) send({ type: "learn", key: norm(f.label), label: f.label, value: v.trim(), ats: detectATS() });
  }
}
// Passive learning: active from page load. Captures EVERY field you fill
// yourself (manual typing, dropdowns, radios) via one delegated change handler,
// not just fields the extension filled. This is "retrain from what I fill."
let AA_LEARNED = 0;
const AA_NOTED = new Set();
function noteLearned(el, label) {
  const k = norm(label);
  const isNew = !AA_NOTED.has(k);
  if (isNew) { AA_NOTED.add(k); AA_LEARNED = AA_NOTED.size; }
  const n = AA_SHADOW && AA_SHADOW.getElementById("aa-learned");
  if (n) n.textContent = `📝 noted ${AA_LEARNED} field${AA_LEARNED === 1 ? "" : "s"} you filled`;
  if (isNew && el) { try { const prev = el.style.boxShadow; el.style.boxShadow = "0 0 0 2px #16a34a"; setTimeout(() => { el.style.boxShadow = prev; }, 800); } catch (e) {} }
}
function startPassiveLearning() {
  if (window.__aaLearn) return; window.__aaLearn = true;
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.tagName || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
    if (["password", "file", "hidden", "submit", "button"].includes(el.type)) return;
    const label = (labelFor(el) || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
    if (!label || label.toLowerCase() === "search") return;
    let v;
    if (el.tagName === "SELECT") v = el.value ? (el.options[el.selectedIndex] || {}).text : "";
    else if (el.type === "checkbox") v = el.checked ? "Yes" : "";
    else if (el.type === "radio") { if (!el.checked) return; v = labelFor(el); }
    else v = el.value;
    if (v && v.trim()) { send({ type: "learn", key: norm(label), label, value: v.trim(), ats: detectATS() }); noteLearned(el, label); }
  }, true);
  // Periodic harvest: catches custom widgets (react-select, button-groups) that
  // never fire a native 'change'. Reads each field's CURRENT value and learns it.
  setInterval(() => {
    if (window.__aaRunning) return; // never re-stamp field ids while a fill run is in flight
    if (!alive()) return;           // extension was reloaded; this orphaned script must go quiet
    let fields; try { fields = enumerate(); } catch (e) { return; }
    for (const f of fields) {
      if (f.type === "file") continue;
      const v = readValue(f);
      if (v && v.trim()) { send({ type: "learn", key: norm(f.label), label: f.label, value: v.trim(), ats: detectATS() }); noteLearned(byAaId(f.id), f.label); }
    }
  }, 4000);
}

// ---------- resolve ----------
// Fields inside a repeating section ("Work Experience 2 - Location") must NOT hit
// the keyword rules - "location" would fill the candidate's city as an employer
// location, "start date" would fill the earliest-start-date. Sections belong to
// the grounded LLM mapper, which knows which entry each section is.
const SECTION_LABEL_RX = /\b(work experience|education|certification|language)s?\s*\d+\s*-/i;
// "Date" on self-ID/signature blocks = today. Deliberately narrow: must NOT match
// start date / end date / date of birth / from-to dates.
const TODAY_RX = /^(today'?s\s+)?date$|^date\s+signed$|^signature\s+date$/i;
// Fields that are never the applicant's to fill, by anyone (human-only or N/A)
const NEVER_FILL_RX = /employee\s*(id|#|number)/i;
function resolve(profile, bank, f) {
  const sens = isSensitive(f.label);
  if (f.type === "file") {
    // markers; the actual file comes from the user's uploaded docs in storage (getDoc)
    const l = f.label.toLowerCase();
    if (/cover/.test(l)) return { value: "cover_letter", source: "profile", sensitive: false, review: false };
    if (/resume|\bcv\b|curriculum/.test(l)) return { value: "resume", source: "profile", sensitive: false, review: false };
    return { value: null, source: "needs_you", sensitive: false, review: true }; // additional attachments etc. -> you
  }
  // self-ID / signature forms (CC-305 etc.): a bare "Date" field means TODAY -
  // filled deterministically because the LLM must never guess dates
  if (TODAY_RX.test(f.label.trim()) && ["text", "date"].includes(f.type)) {
    const d = new Date();
    const v = f.type === "date"
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      : `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    return { value: v, source: "profile", sensitive: false, review: false };
  }
  const inSection = SECTION_LABEL_RX.test(f.label);
  let [pv, pk] = inSection ? [null, null] : valueForLabel(profile, f.label);
  // Workday keeps the country code in its own field - the phone field wants the
  // bare 10-digit national number (5551234567), not +1-555-123-4567
  if (pv != null && pk === "identity.phone" && detectATS() === "workday") {
    let d = String(pv).replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    pv = d;
  }
  // confident answers fill directly ON THE FORM (incl. dropdowns/button-groups)
  if (pv != null && ["text", "textarea", "email", "tel"].includes(f.type)) return { value: pv, source: "profile", sensitive: sens, review: false };
  if (pv != null && ["select", "radio", "checkbox", "buttons", "customselect"].includes(f.type)) { const o = closestOption(pv, f.options); if (o) return { value: o, source: "enum", sensitive: sens, review: false }; }
  const key = norm(f.label);
  if (bank[key]) return { value: bank[key].value, source: "cache", sensitive: sens, review: false };
  // near-identical question to one you already answered -> auto-fill your own
  // prior answer (verified like any fill). Only sensitive ones still ask first.
  // Mid-similarity (0.65-0.8) is a pre-filled suggestion, never an auto-fill:
  // that band contains real traps ("authorized to work" vs "authorized WITHOUT
  // sponsorship") where the answers differ.
  let best = null, s = 0; for (const k in bank) { const j = jaccard(f.label, bank[k].label || k); if (j > s) { s = j; best = bank[k]; } }
  if (best && s >= 0.8) return { value: best.value, source: "semantic", sensitive: sens, review: sens };
  if (best && s >= 0.65) return { value: best.value, source: "semantic", sensitive: sens, review: true };
  if (isFreetext(f)) return { value: null, source: "draft", sensitive: sens, review: true };
  return { value: null, source: "needs_you", sensitive: sens, review: true };
}

// ---------- docked side panel (visible on the page, Jobright-style) ----------
const PANEL_CSS = `
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
.wrap{display:flex;flex-direction:column;max-height:82vh;background:#fff;color:#0f172a;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(2,6,23,.30);border:1px solid #e5e7eb}
.hd{padding:11px 14px 10px;background:#0f172a;color:#fff}
.hrow{display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:650;font-size:13.5px;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:#34d399}
.hbtns{display:flex;gap:5px;align-items:center}
.hbtn{cursor:pointer;color:#cbd5e1;font-size:11.5px;line-height:1;border:0;background:rgba(255,255,255,.08);padding:6px 10px;border-radius:7px;font-weight:600}
.hbtn:hover{background:rgba(255,255,255,.16);color:#fff}
.hsub{color:#94a3b8;font-size:11px;font-weight:500;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.body{padding:12px 14px 13px;overflow:auto;background:#fff}
.btn{width:100%;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:11px;font-weight:650;font-size:13.5px;cursor:pointer;transition:background .15s,transform .05s;letter-spacing:.1px}
.btn:hover{background:#4338ca}.btn:active{transform:scale(.99)}
.summary{display:flex;gap:5px;margin:9px 0 0;flex-wrap:wrap}
.chip{font-size:10.5px;font-weight:650;border-radius:6px;padding:3px 8px;border:1px solid transparent}
.chip.ok{background:#ecfdf5;color:#047857;border-color:#d1fae5}
.chip.warn{background:#fffbeb;color:#b45309;border-color:#fde68a}
.status{color:#64748b;font-size:11.5px;margin:8px 0 0;line-height:1.5}
.learned{font-size:11px;color:#059669;font-weight:600;margin-top:5px}
.learned:empty{display:none}
.row{border:1px solid #e5e7eb;border-left:3px solid #cbd5e1;border-radius:9px;padding:9px 10px;margin-bottom:7px;background:#fff}
.row.sens{border-left-color:#dc2626;background:#fef9f9}
.row.draft{border-left-color:#4f46e5}
.row.fail{border-left-color:#d97706;background:#fffdf4}
.tag{font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94a3b8}
.row.sens .tag{color:#dc2626}.row.draft .tag{color:#4f46e5}.row.fail .tag{color:#b45309}
.lbl{font-weight:650;font-size:12.5px;margin:4px 0 7px;word-break:break-word;line-height:1.35}
.fld{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:8px;font-size:13px;color:#0f172a;background:#fff;outline:none}
.fld:focus{border-color:#4f46e5;box-shadow:0 0 0 3px #e0e7ff}
textarea.fld{resize:vertical;min-height:34px}
.acts{display:flex;gap:7px;margin-top:8px}
.apply{flex:1;background:#0f172a;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:600;font-size:12.5px;cursor:pointer}
.apply:hover{background:#1e293b}
.draftb{background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;border-radius:8px;padding:8px 11px;cursor:pointer;font-weight:600;font-size:12.5px}
.draftb:hover{background:#e0e7ff}
.empty{color:#94a3b8;font-size:12.5px;text-align:center;padding:14px 0}
.btnrow{display:flex;gap:6px;margin-top:6px}
.ghostb{flex:1;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:9px;padding:8px;font-weight:600;font-size:11.5px;cursor:pointer;white-space:nowrap}
.ghostb:hover{background:#f1f5f9}
.autop{flex:0 0 auto;display:flex;align-items:center;gap:5px;font-size:11px;color:#475569;font-weight:600;cursor:pointer;user-select:none;border:1px solid #e2e8f0;border-radius:9px;padding:0 10px;background:#fff}
.autop:hover{background:#f1f5f9}
.autop input{accent-color:#4f46e5;margin:0}
.fsec{border:1px solid #e5e7eb;border-radius:9px;margin:8px 0 7px;overflow:hidden}
.fsec.bad{border-color:#fecaca}
.fhd{display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:#f8fafc;font-weight:650;font-size:12px;cursor:pointer;color:#0f172a}
.fsec.bad .fhd{background:#fef2f2;color:#b91c1c}
.fhd:hover{filter:brightness(.98)}
.flist{max-height:230px;overflow:auto;border-top:1px solid #eef2f7}
.frow{display:flex;justify-content:space-between;gap:8px;padding:7px 11px;border-bottom:1px solid #f8fafc;cursor:pointer;font-size:11.5px}
.frow:hover{background:#fafbff}
.flbl{color:#475569;font-weight:600;max-width:48%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fval{color:#0f172a;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.frow.req .flbl,.frow.req .fval{color:#dc2626}
.aibar{display:flex;gap:6px;margin-top:7px;align-items:center}
.aibar .aiq{flex:1;font-size:12px;padding:7px 9px}
.aigo{flex:0 0 auto;padding:7px 13px}
`;
let AA_SHADOW = null;
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function flashField(id) {
  const el = byAaId(id); if (!el) return;
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const prev = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 3px #4f46e5";
    setTimeout(() => { el.style.boxShadow = prev; }, 1400);
  } catch (e) {}
}
function rowHTML(it) {
  const cls = it.failed ? "fail" : it.sensitive ? "sens" : (it.source === "draft" || it.source === "tailored letter" ? "draft" : "");
  const tag = it.failed ? "fill failed - retry or do it on the form" : it.needsHuman ? "needs your words" : it.sensitive ? "Review" : it.source;
  const applyLabel = it.source === "tailored letter" ? "Upload as PDF" : "Apply";
  const isText = !(it.options && it.options.length);
  const inner = !isText
    ? `<select class="fld" data-edit="${it.id}"><option value="">— choose —</option>${it.options.map((o) => `<option${o === it.value ? " selected" : ""}>${escH(o)}</option>`).join("")}</select>`
    : `<textarea class="fld" data-edit="${it.id}" rows="${it.type === "textarea" ? 4 : 1}">${escH(it.value || "")}</textarea>`;
  const aiBtn = isText ? `<button class="draftb" data-aiedit="${it.id}" title="Rewrite this answer with an instruction">✦ AI edit</button>` : "";
  const aiBar = isText ? `<div class="aibar" data-aibar="${it.id}" style="display:none"><input class="fld aiq" data-aiq="${it.id}" placeholder="e.g. shorter · mention my Rust work · less formal"><button class="apply aigo" data-aigo="${it.id}">Go</button></div>` : "";
  return `<div class="row ${cls}" data-row="${it.id}"><div class="tag">${escH(tag)}</div><div class="lbl">${escH(it.label)}</div>${inner}<div class="acts"><button class="apply" data-apply="${it.id}">${applyLabel}</button>${it.source === "draft" || it.source === "tailored letter" ? `<button class="draftb" data-redraft="${it.id}">Redraft</button>` : ""}${aiBtn}</div>${aiBar}</div>`;
}
function filledListHTML(rows, idAttr, open) {
  return `<div class="flist" id="${idAttr}" style="display:${open ? "block" : "none"}">${rows.join("")}</div>`;
}
function renderResults(items, filled) {
  const sh = AA_SHADOW; if (!sh) return;
  filled = filled || [];
  const failedN = items.filter((it) => it.failed).length;
  const needN = items.length - failedN;
  const st = sh.getElementById("aa-status");
  if (st) st.innerHTML = `<div class="summary"><span class="chip ok">✓ ${filled.length} filled & verified</span>${failedN ? `<span class="chip warn">⚠ ${failedN} fill failed</span>` : ""}${needN ? `<span class="chip warn">${needN} need you</span>` : ""}</div>`;
  const box = sh.getElementById("aa-results");
  const frows = filled.map((x) => `<div class="frow" data-goto="${x.id}"><span class="flbl" title="${escH(x.label)}">${escH(x.label)}</span><span class="fval" title="${escH(x.value)}">${escH(x.value)}</span></div>`);
  const fsec = filled.length ? `<div class="fsec"><div class="fhd" data-ftog="aa-flist">Filled fields (${filled.length})<span>▾</span></div>${filledListHTML(frows, "aa-flist", false)}</div>` : "";
  const applicable = items.filter((it) => !it.sensitive && it.source !== "tailored letter" && it.value && String(it.value).trim());
  const applyAll = applicable.length >= 2 ? `<button class="ghostb" id="aa-applyall" style="width:100%;margin:0 0 8px">Apply all suggestions (${applicable.length})</button>` : "";
  box.innerHTML = fsec + applyAll + (items.length ? items.map(rowHTML).join("") : (filled.length ? "" : '<div class="empty">All set — nothing needs you.</div>'));
  wireResultHandlers(box, items);
  const aa = box.querySelector("#aa-applyall");
  if (aa) aa.onclick = async () => {
    aa.disabled = true;
    let n = 0;
    for (const it of applicable) {
      aa.textContent = `Applying ${++n}/${applicable.length}…`;
      const ta = box.querySelector(`[data-edit="${it.id}"]`);
      const v = ta ? ta.value : it.value;
      if (!v || !String(v).trim()) continue;
      try { await fillField(it, String(v)); markField(byAaId(it.id), "verified"); } catch (e) {}
      send({ type: "learn", key: norm(it.label), label: it.label, value: String(v), ats: detectATS() });
      const row = box.querySelector(`[data-row="${it.id}"]`); if (row) row.style.opacity = .5;
      const btn = box.querySelector(`[data-apply="${it.id}"]`); if (btn) btn.textContent = "✓ Applied";
    }
    aa.textContent = "✓ All applied";
  };
}
function wireResultHandlers(box, items) {
  box.querySelectorAll("[data-ftog]").forEach((h) => (h.onclick = () => { const fl = box.querySelector("#" + h.dataset.ftog); if (fl) fl.style.display = fl.style.display === "none" ? "block" : "none"; }));
  box.querySelectorAll("[data-goto]").forEach((r) => (r.onclick = () => flashField(r.dataset.goto)));
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  box.querySelectorAll("[data-apply]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.apply; const v = box.querySelector(`[data-edit="${id}"]`).value;
    if (byId[id].source === "tailored letter") {
      if (!v.trim()) return;
      const el = byAaId(id);
      if (el) {
        const fname = (window.__aaFullName ? window.__aaFullName.replace(/\s+/g, "_") + "_" : "") + "Cover_Letter.pdf";
        attachFileToInput(el, dataURLtoFile(textToPdfDataUrl(v), fname));
        box.querySelector(`[data-row="${id}"]`).style.opacity = .5; b.textContent = "✓ Uploaded";
      }
      return;
    }
    await fillField(byId[id], v);
    await send({ type: "learn", key: norm(byId[id].label), label: byId[id].label, value: v, ats: detectATS() });
    box.querySelector(`[data-row="${id}"]`).style.opacity = .5; b.textContent = "✓ Applied";
  }));
  box.querySelectorAll("[data-redraft]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.redraft; const ta = box.querySelector(`[data-edit="${id}"]`); ta.value = "drafting…";
    const q = byId[id].source === "tailored letter" ? "Cover letter for this role" : byId[id].label;
    const r = await send({ type: "draft", question: q, jd: CURRENT_JD, examples: topBank(byId[id].label, 5) });
    ta.value = (r && r.text) || ("[" + ((r && r.error) || "error") + "]");
  }));
  // "Edit with AI": give an instruction, the draft is rewritten (still grounded)
  box.querySelectorAll("[data-aiedit]").forEach((b) => (b.onclick = () => {
    const bar = box.querySelector(`[data-aibar="${b.dataset.aiedit}"]`);
    if (!bar) return;
    bar.style.display = bar.style.display === "none" ? "flex" : "none";
    if (bar.style.display === "flex") { const q = bar.querySelector("input"); if (q) q.focus(); }
  }));
  const doRefine = async (id) => {
    const ta = box.querySelector(`[data-edit="${id}"]`);
    const q = box.querySelector(`[data-aiq="${id}"]`);
    const go = box.querySelector(`[data-aigo="${id}"]`);
    if (!ta || !q || !q.value.trim()) return;
    const orig = ta.value;
    ta.value = "rewriting…"; if (go) go.textContent = "…";
    const question = byId[id] && byId[id].source === "tailored letter" ? "Cover letter for this role" : (byId[id] ? byId[id].label : "");
    const r = await send({ type: "refine", question, current: orig, instruction: q.value.trim(), jd: CURRENT_JD });
    ta.value = (r && r.text) || orig;
    if (go) go.textContent = "Go";
    if (r && r.text) q.value = "";
  };
  box.querySelectorAll("[data-aigo]").forEach((b) => (b.onclick = () => doRefine(b.dataset.aigo)));
  box.querySelectorAll("[data-aiq]").forEach((inp) => (inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doRefine(inp.dataset.aiq); } }));
}

// ---------- pre-submit audit: what's actually in the form RIGHT NOW ----------
async function auditPage() {
  const sh = AA_SHADOW; if (!sh) return;
  const fields = enumerate();
  const reqEmpty = [], have = []; let optEmpty = 0;
  for (const f of fields) {
    if (NEVER_FILL_RX.test(f.label)) continue;
    let v = "";
    try {
      if (f.type === "file") { const el = byAaId(f.id); v = el && el.files && el.files.length ? "uploaded: " + el.files[0].name : ""; }
      else v = String(readValue(f) || "");
    } catch (e) {}
    v = v.trim();
    if (v) have.push({ id: f.id, label: f.label, value: v });
    else if (f.required) reqEmpty.push({ id: f.id, label: f.label, value: "EMPTY - required" });
    else optEmpty++;
  }
  const st = sh.getElementById("aa-status");
  if (st) st.innerHTML = `<div class="summary">${reqEmpty.length ? `<span class="chip warn">⚠ ${reqEmpty.length} required still empty</span>` : '<span class="chip ok">✓ no required fields empty</span>'}<span class="chip ok">${have.length} answered</span></div>`;
  const box = sh.getElementById("aa-results");
  const badRows = reqEmpty.map((x) => `<div class="frow req" data-goto="${x.id}"><span class="flbl" title="${escH(x.label)}">${escH(x.label)}</span><span class="fval">empty</span></div>`);
  const okRows = have.map((x) => `<div class="frow" data-goto="${x.id}"><span class="flbl" title="${escH(x.label)}">${escH(x.label)}</span><span class="fval" title="${escH(x.value)}">${escH(x.value)}</span></div>`);
  box.innerHTML =
    (reqEmpty.length ? `<div class="fsec bad"><div class="fhd" data-ftog="aa-badlist">Required & empty (${reqEmpty.length})<span>▾</span></div>${filledListHTML(badRows, "aa-badlist", true)}</div>` : "") +
    `<div class="fsec"><div class="fhd" data-ftog="aa-oklist">Everything answered (${have.length})<span>▾</span></div>${filledListHTML(okRows, "aa-oklist", true)}</div>` +
    (optEmpty ? `<div class="empty">${optEmpty} optional field${optEmpty === 1 ? "" : "s"} left blank</div>` : "");
  wireResultHandlers(box, []);
}
function mountPanel() {
  if (document.getElementById("aa-root") || !document.body) return;
  let jd = { company: "", title: "" }; try { jd = extractJD(); } catch (e) {}
  const co = jd.company || detectATS() || "Application";
  const host = document.createElement("div"); host.id = "aa-root";
  host.style.cssText = "position:fixed;bottom:18px;right:18px;width:332px;z-index:2147483647";
  try {
    chrome.storage.local.get("panelPos", (v) => {
      const p = v && v.panelPos;
      if (p && typeof p.left === "number") { host.style.left = Math.max(0, Math.min(p.left, innerWidth - 80)) + "px"; host.style.top = Math.max(0, Math.min(p.top, innerHeight - 60)) + "px"; host.style.right = "auto"; host.style.bottom = "auto"; }
    });
  } catch (e) {}
  const sh = host.attachShadow({ mode: "open" }); AA_SHADOW = sh;
  sh.innerHTML = `<style>${PANEL_CSS}</style><div class="wrap"><div class="hd"><div class="hrow"><span class="brand"><span class="dot"></span>AutoApply</span><span class="hbtns"><button class="hbtn" id="aa-dash" title="Open applications dashboard">Dashboard</button><button class="hbtn" id="aa-min" title="Minimize">–</button></span></div><div class="hsub" title="${escH(co)}${jd.title ? " · " + escH(jd.title) : ""}">${escH(co)}${jd.title ? " · " + escH(jd.title) : ""}</div></div><div class="body" id="aa-body"><button class="btn" id="aa-run">⚡ Autofill this page</button><div class="btnrow"><button class="ghostb" id="aa-audit" title="Re-read every field and flag empty required ones">✓ Check before submit</button><label class="autop" title="Re-run Autofill automatically when the wizard moves to a new page (Workday)"><input type="checkbox" id="aa-auto"> Auto-run</label></div><div class="status" id="aa-status">Ready</div><div class="learned" id="aa-learned"></div><div id="aa-results"></div></div></div>`;
  document.body.appendChild(host);
  startPassiveLearning(); // learn from manual page fills, even before Autofill
  startSubmitWatch();
  startAiEditButtons();
  sh.getElementById("aa-run").onclick = () => run().catch((e) => console.warn("[aa]", e));
  sh.getElementById("aa-audit").onclick = () => auditPage().catch((e) => console.warn("[aa]", e));
  sh.getElementById("aa-dash").onclick = () => send({ type: "openDashboard" });
  sh.getElementById("aa-min").onclick = () => { const bd = sh.getElementById("aa-body"); bd.style.display = bd.style.display === "none" ? "block" : "none"; };
  const autoBox = sh.getElementById("aa-auto");
  try { chrome.storage.local.get("autopilot", (v) => { AA_AUTO = !!(v && v.autopilot); autoBox.checked = AA_AUTO; }); } catch (e) {}
  autoBox.onchange = () => { AA_AUTO = autoBox.checked; try { chrome.storage.local.set({ autopilot: AA_AUTO }); } catch (e) {} };
  // drag the panel by its header (so it never has to cover the field you're reviewing)
  const hd = sh.querySelector(".hd");
  hd.style.cursor = "grab";
  hd.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    const move = (ev) => {
      const left = Math.max(0, Math.min(ev.clientX - dx, innerWidth - 80));
      const top = Math.max(0, Math.min(ev.clientY - dy, innerHeight - 40));
      host.style.left = left + "px"; host.style.top = top + "px";
      host.style.right = "auto"; host.style.bottom = "auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      try { chrome.storage.local.set({ panelPos: { left: parseInt(host.style.left) || 0, top: parseInt(host.style.top) || 0 } }); } catch (err) {}
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  (async () => { const p = await send({ type: "getProfile" }); const doc = await send({ type: "getDoc", kind: "resume" }); const st = sh.getElementById("aa-status"); if (st && st.textContent === "Ready") st.textContent = (p ? "✓ profile" : "✗ profile") + " · " + (doc ? "✓ resume ready" : "✗ no resume"); })();
}

// ---------- autopilot: auto-run when a wizard (Workday) moves to a new page ----------
let AA_AUTO = false;
let LAST_SIG = "";
let _candSig = "", _candTicks = 0;
function pageSig() {
  let h = "";
  try { const hd = document.querySelector("h1,h2,[role=heading]"); h = hd ? (hd.innerText || "").trim().slice(0, 80) : ""; } catch (e) {}
  let n = 0; try { n = deepQSA("input,textarea,select").length; } catch (e) {}
  return location.href + "::" + h + "::" + n;
}
setInterval(() => {
  if (!AA_AUTO || !alive() || window.__aaRunning || !detectATS()) return;
  const sig = pageSig();
  if (sig === LAST_SIG) { _candSig = ""; _candTicks = 0; return; }
  // require the new page to be stable for 2 consecutive ticks before running
  if (sig === _candSig) _candTicks++; else { _candSig = sig; _candTicks = 1; }
  if (_candTicks >= 2 && deepQSA("input,textarea,select").length >= 3) {
    _candSig = ""; _candTicks = 0;
    LAST_SIG = sig; // claim it now so a slow run doesn't double-trigger
    run().catch((e) => console.warn("[aa] autopilot:", e));
  }
}, 1200);

// ---------- on-field "AI edit" (button lives on the form field itself) ----------
let AIE = null;
function aiEditUI() {
  if (AIE) return AIE;
  const host = document.createElement("div");
  host.id = "aa-aiedit";
  host.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `<style>
  .b{position:fixed;display:none;align-items:center;gap:4px;background:#4f46e5;color:#fff;border:0;border-radius:7px;padding:4px 9px;font:600 11px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(2,6,23,.3)}
  .b:hover{background:#4338ca}
  .p{position:fixed;display:none;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 14px 40px rgba(2,6,23,.28);padding:9px;width:300px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
  .p input{width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:7px;padding:7px 9px;font-size:12px;outline:none;color:#0f172a}
  .p input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px #e0e7ff}
  .pr{display:flex;gap:6px;margin-top:7px}
  .go{flex:1;background:#0f172a;color:#fff;border:0;border-radius:7px;padding:7px;font-weight:600;font-size:12px;cursor:pointer}
  .go:hover{background:#1e293b}
  .x{background:#f1f5f9;color:#0f172a;border:0;border-radius:7px;padding:7px 10px;font-weight:600;font-size:12px;cursor:pointer}
  </style>
  <button class="b" id="b">✦ AI edit</button>
  <div class="p" id="p"><input id="q" placeholder="e.g. shorter · more specific · mention my Rust work"><div class="pr"><button class="go" id="go">Rewrite</button><button class="x" id="x">✕</button></div></div>`;
  document.documentElement.appendChild(host);
  AIE = { host, btn: sh.getElementById("b"), pop: sh.getElementById("p"), q: sh.getElementById("q"), go: sh.getElementById("go"), target: null, busy: false };
  AIE.btn.onclick = () => { aiePositionPop(); AIE.pop.style.display = "block"; AIE.q.focus(); };
  sh.getElementById("x").onclick = () => aieHide();
  const doGo = async () => {
    const el = AIE.target, instr = AIE.q.value.trim();
    if (!el || !instr || AIE.busy) return;
    AIE.busy = true; AIE.go.textContent = "Rewriting…";
    const label = (labelFor(el) || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
    const jd = CURRENT_JD || (() => { try { return extractJD(); } catch (e) { return null; } })();
    const cur = el.value || "";
    const r = cur.trim()
      ? await send({ type: "refine", question: label, current: cur, instruction: instr, jd })
      : await send({ type: "draft", question: label + " (" + instr + ")", jd, examples: topBank(label, 5) });
    AIE.busy = false; AIE.go.textContent = "Rewrite";
    if (r && r.text) {
      setNative(el, r.text);
      markField(el, "verified");
      send({ type: "learn", key: norm(label), label, value: r.text, ats: detectATS() });
      AIE.q.value = "";
      aieHide();
    } else AIE.go.textContent = (r && r.needsHuman) ? "Not enough resume facts" : "Error - try again";
  };
  AIE.go.onclick = doGo;
  AIE.q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doGo(); } else if (e.key === "Escape") aieHide(); };
  return AIE;
}
function aiePositionBtn() {
  if (!AIE || !AIE.target) return;
  const rct = AIE.target.getBoundingClientRect();
  AIE.btn.style.left = Math.max(4, rct.right - 82) + "px";
  AIE.btn.style.top = Math.max(4, rct.top - 13) + "px";
}
function aiePositionPop() {
  const rct = AIE.target.getBoundingClientRect();
  AIE.pop.style.left = Math.max(4, Math.min(rct.right - 300, innerWidth - 312)) + "px";
  AIE.pop.style.top = Math.min(rct.top + 14, innerHeight - 130) + "px";
}
function aieHide() { if (!AIE) return; AIE.btn.style.display = "none"; AIE.pop.style.display = "none"; AIE.target = null; }
function aieEligible(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT" && (el.type || "text") === "text") {
    const l = (labelFor(el) || "").toLowerCase();
    return FREETEXT.some((h) => l.includes(h)); // long-answer text inputs only
  }
  return false;
}
function startAiEditButtons() {
  if (window.__aaAiEdit) return; window.__aaAiEdit = true;
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el && el.closest && (el.closest("#aa-root") || el.closest("#aa-aiedit"))) return;
    if (!aieEligible(el)) return;
    const ui = aiEditUI();
    if (ui.target && ui.target !== el) aieHide();
    ui.target = el;
    aiePositionBtn();
    ui.btn.style.display = "flex";
  }, true);
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!AIE || AIE.pop.style.display === "block") return;
      const ae = document.activeElement;
      if (ae === AIE.target) return;
      if (ae && (ae.id === "aa-aiedit" || (ae.closest && ae.closest("#aa-aiedit")))) return;
      AIE.btn.style.display = "none";
    }, 180);
  }, true);
  const reposition = () => { if (AIE && AIE.target && AIE.btn.style.display !== "none") { aiePositionBtn(); if (AIE.pop.style.display === "block") aiePositionPop(); } };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
}

// ---------- application tracking (feeds the dashboard) ----------
function appKey() { return location.origin + location.pathname.replace(/\/(apply|application)\b.*$/i, ""); }
function appRecord(extra) {
  const jd = CURRENT_JD || (() => { try { return extractJD(); } catch (e) { return {}; } })();
  return { key: appKey(), url: location.href, company: jd.company || "", title: jd.title || "", ats: detectATS() || "", ts: Date.now(), ...extra };
}
// Small confirmation toast (bottom-center, auto-fades).
function showToast(text) {
  try {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 18px;border-radius:10px;font:600 13px -apple-system,system-ui,sans-serif;z-index:2147483647;box-shadow:0 10px 30px rgba(2,6,23,.35);opacity:0;transition:opacity .25s";
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = "1"; });
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 2600);
  } catch (e) {}
}
// Flip the record to "applied" when you click the real Submit button.
function startSubmitWatch() {
  if (window.__aaSubmit) return; window.__aaSubmit = true;
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button,[role=button],input[type=submit]");
    if (!b) return;
    const txt = ((b.innerText || b.value || "")).replace(/\s+/g, " ").trim().toLowerCase();
    const aid = (b.getAttribute && b.getAttribute("data-automation-id") || "").toLowerCase();
    if (/^submit( application| your application)?$/.test(txt) || /submit/.test(aid)) {
      send({ type: "trackApp", app: appRecord({ status: "applied" }) }).then(() => showToast("Tracked as applied ✓ - see Dashboard"));
    }
  }, true);
}

// ---------- Workday repeating sections: create the panels before filling ----------
function findAddBtn(scope) {
  return [...scope.querySelectorAll("button")].find((b) => {
    if (b.offsetParent === null) return false;
    const t = (b.innerText || "").trim().toLowerCase();
    const aid = (b.getAttribute("data-automation-id") || "").toLowerCase();
    return /^add( another)?$/.test(t) || aid === "add-button" || aid === "add";
  });
}
// Click "Add" in the Work Experience / Education sections until there is one
// panel per profile entry. Never removes anything; if a tenant's markup hides
// the buttons, it just fills whatever panels exist.
async function wdEnsureSections(profile) {
  if (detectATS() !== "workday") return;
  const targets = [
    [/^work experience$/i, (profile.experience || []).length],
    [/^education$/i, (profile.education || []).length],
  ];
  for (const [rx, want] of targets) {
    if (!want) continue;
    const head = [...document.querySelectorAll("h2,h3,h4,[role=heading]")]
      .find((h) => rx.test((h.innerText || "").replace(/\s+/g, " ").trim()));
    if (!head) continue;
    let container = null;
    for (let n = head.parentElement, k = 0; k < 8 && n; k++, n = n.parentElement) {
      if (findAddBtn(n)) { container = n; break; }
    }
    if (!container) continue;
    const panelRx = new RegExp(rx.source.replace(/[\^$]/g, "") + "\\s+\\d+", "i");
    const countPanels = () => [...container.querySelectorAll("h3,h4,h5,[role=heading]")]
      .filter((h) => panelRx.test((h.innerText || "").replace(/\s+/g, " ").trim())).length;
    let guard = 0;
    while (countPanels() < want && guard++ < 8) {
      const btn = findAddBtn(container);
      if (!btn) break;
      const before = countPanels();
      btn.click();
      let grew = false;
      for (let i = 0; i < 20; i++) { await sleep(150); if (countPanels() > before) { grew = true; break; } }
      if (!grew) break; // markup we don't understand - stop clicking, fill what exists
    }
  }
}

// ---------- run ----------
async function run() {
  window.__aaRunning = true;
  try { await runInner(); } finally { window.__aaRunning = false; }
}
// On-form markers: green dot-outline = filled & verified, amber = needs your eyes.
// Cleared the moment you interact with the field.
function markField(el, kind) {
  if (!el) return;
  try {
    const color = kind === "verified" ? "rgba(16,185,129,.85)" : "rgba(245,158,11,.9)";
    el.dataset.aaPrevOutline = el.style.outline || "";
    el.style.outline = "2px solid " + color;
    el.style.outlineOffset = "1px";
    const clear = () => { try { el.style.outline = el.dataset.aaPrevOutline || ""; el.style.outlineOffset = ""; } catch (e) {} };
    el.addEventListener("focus", clear, { once: true, capture: true });
    el.addEventListener("input", clear, { once: true, capture: true });
  } catch (e) {}
}

async function runInner() {
  const ats = detectATS(); if (!ats) return alert("Not a recognized application page.");
  const setStatus = (t) => { const st = AA_SHADOW && AA_SHADOW.getElementById("aa-status"); if (st) st.innerHTML = t; };
  const prog = (step, text) => setStatus(`<b style="color:#4f46e5">Step ${step}/4</b> · ${text}`);
  const profile = await send({ type: "getProfile" });
  if (!profile) { setStatus('<span style="color:#c2410c">⚠ Extension was updated - refresh this page (Cmd+R), then click Autofill again</span>'); return; }
  const bank = (await send({ type: "getBank" })) || {};
  CURRENT_BANK = bank;
  CURRENT_JD = extractJD();

  if (ats === "workday") {
    setStatus("Adding Work Experience / Education entries…");
    try { await wdEnsureSections(profile); } catch (e) { console.warn("[aa] sections:", e); }
  }

  window.__aaFullName = ((profile.identity || {}).full_name || "").trim();
  prog(1, "Reading the form…");
  const fields = enumerate();
  // LAZY option reading: only open dropdowns the deterministic layer can't
  // already answer (those need the LLM, which needs exact options). Known
  // answers click their option live during fill - no pre-reading needed.
  const lazyDrops = fields.filter((f) => (f.type === "customselect" || f.type === "wdlistbox") && !readValue(f) && (() => { const a0 = resolve(profile, bank, f); return !(a0.value != null && !a0.review); })());
  for (let i = 0; i < lazyDrops.length; i++) {
    const f = lazyDrops[i];
    prog(1, `Reading dropdown options ${i + 1}/${lazyDrops.length}…`);
    const el = byAaId(f.id);
    try {
      if (f.type === "customselect") f.options = await readSelectOptions(el);
      else f.options = await readWdOptions(el);
    } catch (e) {}
  }

  // LLM = universal mapper: understands each question + maps to your data (any ATS)
  let llm = {}, llmReview = {}, rejectedN = 0; let noKey = false;
  const slim = fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: (f.options || []).slice(0, 25) }));
  const t0 = Date.now();
  prog(2, `AI mapping ${slim.length} questions…`);
  const aiTick = setInterval(() => prog(2, `AI mapping ${slim.length} questions… ${Math.round((Date.now() - t0) / 1000)}s`), 1000);
  const r = await send({ type: "mapFields", fields: slim, jd: CURRENT_JD });
  clearInterval(aiTick);
  if (r && r.map) { llm = r.map; llmReview = r.review || {}; rejectedN = Object.keys(r.rejected || {}).length; }
  else if (r && r.error === "no_key") noKey = true;
  const variant = (r && r.variant) === "ai" ? "ai" : "systems";
  window.__aaVariant = variant;

  const review = []; const filled = [];
  let scanned = 0;
  for (const f of fields) {
    prog(3, `Filling ${filled.length} · checking field ${++scanned}/${fields.length}…`);
    // If YOU already filled/selected this field, NEVER overwrite it. Just learn from it.
    const cur = (() => { try { return readValue(f); } catch (e) { return ""; } })();
    if (cur && String(cur).trim()) {
      if (f.type !== "file") {
        send({ type: "learn", key: norm(f.label), label: f.label, value: String(cur).trim(), ats });
        noteLearned(byAaId(f.id), f.label);
      }
      continue; // skip empty-only: leave your selection untouched
    }
    if (NEVER_FILL_RX.test(f.label)) continue; // e.g. Employee ID - applicants leave it blank
    const a = resolve(profile, bank, f); // exact profile facts (links/email), enum, learned answers
    let value = null, source = null;
    // 1. deterministic: your profile facts AND what you taught it both beat the AI guess
    if (a.value != null && !a.review) { value = a.value; source = a.source; }
    // 2. else the AI maps it (custom questions the profile does not cover)
    if (value == null) { const lv = llm[f.id]; if (lv != null && String(lv).trim() !== "" && String(lv).toLowerCase() !== "null") { value = String(lv); source = "ai"; } }
    if (value == null) {
      // low-confidence AI answer: never auto-filled, shown for your decision
      if (llmReview[f.id]) { review.push({ ...f, value: llmReview[f.id], source: "ai unsure", sensitive: a.sensitive }); markField(byAaId(f.id), "review"); continue; }
      // nothing confident: leave it on the form (you fill, it learns). Review only AI drafts.
      if (f.type === "checkbox") continue;
      if (a.source === "draft" || (a.value != null && String(a.value).trim() !== "")) {
        review.push({ ...f, value: a.value, source: a.source, sensitive: a.sensitive });
      }
      continue;
    }
    // fill, then VERIFY by reading the DOM back - a fill that didn't take is
    // surfaced for you instead of silently counted as done
    let ok = false;
    try {
      await fillField(f, value);
      await sleep(120);
      ok = verifyFill(f, value);
    } catch (e) { console.warn("[aa] fill failed:", f.label, e); }
    if (ok) {
      filled.push({ id: f.id, label: f.label, value: f.type === "file" ? "uploaded" : value, source });
      markField(byAaId(f.id), "verified");
      // a successfully uploaded cover-letter PDF still gets a tailored-letter offer
      if (f.type === "file" && /cover/i.test(f.label)) review.push({ ...f, type: "textarea", value: "", source: "tailored letter", sensitive: false });
    }
    else { review.push({ ...f, value, source, sensitive: a.sensitive, failed: true }); markField(byAaId(f.id), "review"); }
  }
  // draft any remaining free-text from resume + JD (and the tailored cover letter)
  prog(4, "Drafting written answers…");
  for (const it of review) if ((it.source === "draft" || it.source === "tailored letter") && !it.value) {
    const dr = await send({ type: "draft", question: it.source === "tailored letter" ? "Cover letter for this role" : it.label, jd: CURRENT_JD, examples: topBank(it.label, 5) });
    if (dr && dr.needsHuman) { it.value = ""; it.needsHuman = true; continue; }
    it.value = (dr && dr.text) || "";
    if (it.value && it.source === "draft") await fillField(it, it.value);
  }
  renderResults(review, filled);
  try { send({ type: "trackApp", app: appRecord({ filled: filled.length, needsYou: review.length, variant }) }); } catch (e) {}
  try {
    send({ type: "logRun", entry: {
      ts: Date.now(), url: location.href, ats, company: CURRENT_JD.company, title: CURRENT_JD.title, variant,
      fields: fields.length, filled: filled.map((x) => ({ label: x.label, value: String(x.value).slice(0, 150), source: x.source })),
      failed: review.filter((x) => x.failed).map((x) => ({ label: x.label, value: String(x.value || "").slice(0, 150) })),
      aiUnsure: Object.keys(llmReview).length, rejected: (r && r.rejected) || {}, mapperError: (r && r.error) || null,
    } });
  } catch (e) {}
  if (noKey) setStatus('<span style="color:#c2410c">⚠ Add your API key in the popup so AI can map every question</span>');
  else if (!r) setStatus('<span style="color:#c2410c">⚠ Lost contact with the extension - refresh this page and try again</span>');
  else if (r && r.error) setStatus('<span style="color:#c2410c">⚠ AI error: ' + String(r.error).slice(0, 70) + '</span>');
  else if (r && r.map) {
    const mapped = Object.keys(llm).length;
    setStatus('<span style="color:#16a34a">✓ AI mapped ' + mapped + ' questions</span>'
      + (rejectedN ? ' <span style="color:#c2410c">· ' + rejectedN + ' ungrounded answer' + (rejectedN === 1 ? "" : "s") + ' blocked</span>' : "")
      + ' <span style="color:#64748b">· resume: ' + (variant === "ai" ? "AI variant" : "systems") + ' (<a id="aa-swap" style="color:#4f46e5;cursor:pointer;text-decoration:underline">switch</a>)</span>');
    const sw = AA_SHADOW && AA_SHADOW.getElementById("aa-swap");
    if (sw) sw.onclick = async () => {
      window.__aaVariant = window.__aaVariant === "ai" ? "systems" : "ai";
      for (const f of fields) if (f.type === "file" && /resume|\bcv\b/i.test(f.label)) { const el = byAaId(f.id); if (el) await fillFile(el, "resume"); }
      sw.parentElement.firstChild.textContent = "";
      sw.previousSibling.textContent = "· resume: " + (window.__aaVariant === "ai" ? "AI variant" : "systems") + " ";
    };
  }
  LAST_SIG = pageSig(); // autopilot: this page is done; only a NEW page should auto-run
  startPassiveLearning();
}

// Read the DOM back after a fill and confirm the value actually took.
function verifyFill(f, want) {
  const el = byAaId(f.id);
  if (!el) return false;
  if (f.type === "file") return !!(el.files && el.files.length);
  if (f.type === "checkbox") return el.checked === /^(yes|true|1|on)$/i.test(want);
  let got = "";
  try { got = String(readValue(f) || ""); } catch (e) { return false; }
  const g = got.trim(); if (!g) return false;
  const ng = norm(g), nw = norm(want);
  if (!nw) return true;
  return ng === nw || ng.includes(nw) || nw.includes(ng) || jaccard(g, want) >= 0.6;
}

// Mount one panel, only in the frame that actually holds the form.
function shouldMount() { return detectATS() && document.querySelectorAll("input,textarea,select").length >= 3; }
if (detectATS()) { startPassiveLearning(); startSubmitWatch(); startAiEditButtons(); } // learn even if the panel never mounts
if (shouldMount()) mountPanel();
setInterval(() => { if (alive() && shouldMount() && !document.getElementById("aa-root")) mountPanel(); }, 3000);
