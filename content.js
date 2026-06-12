// In-page brain. Runs on the application page you're looking at.
// Deterministic fields fill from your profile; free-text drafts from your resume
// (via the background LLM call); your edits train the answer bank. You submit.

try { document.documentElement.dataset.aaLoaded = "1"; } catch (e) {}
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

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
  for (const [o, n] of pairs) if (n && (v.includes(n) || n.includes(v))) return o;
  let best = null, s = 0; for (const [o, n] of pairs) { if (!n) continue; const j = jaccard(value, o); if (j > s) { best = o; s = j; } }
  return s > 0 ? best : null;
}

// ---------- ATS detection ----------
function detectATS() {
  const h = location.host;
  if (h.includes("greenhouse.io")) return "greenhouse";
  if (h.includes("lever.co")) return "lever";
  if (h.includes("ashbyhq.com")) return "ashby";
  if (h.includes("myworkdayjobs.com")) return "workday";
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
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og && og.content) return og.content.trim();
  const path = location.pathname.split("/").filter(Boolean);
  const h = location.host;
  if (h.includes("ashbyhq") || h.includes("lever.co") || h.includes("greenhouse.io")) return path[0] || "";
  if (h.includes("myworkdayjobs")) return h.split(".")[0] || "";
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
  if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText.trim()) return l.innerText.trim(); }
  const wrap = el.closest("label"); if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
  const lb = el.getAttribute("aria-labelledby");
  if (lb) { const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ").trim(); if (t) return t; }
  const fw = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
  if (fw) { const l = fw.querySelector("label,.label"); if (l && l.innerText.trim()) return l.innerText.trim(); }
  return el.getAttribute("placeholder") || el.name || "";
}
function enumerate() {
  const out = []; let i = 0, fileSeen = 0;
  const fileCount = document.querySelectorAll("input[type=file]").length;
  document.querySelectorAll("input,textarea,select").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text").toLowerCase() : tag;
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return;
    if (el.disabled) return;
    if (el.closest("[class*=select__control],[class*=-control]")) return; // react-select internal input
    const st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") { if (type !== "file") return; }
    if (type === "radio" && out.find((o) => o.type === "radio" && o.name === el.name)) return;
    const id = "aa-" + i++; el.setAttribute("data-aa-id", id);
    let options = [];
    if (tag === "select") options = [...el.options].map((o) => o.text.trim()).filter(Boolean);
    else if (type === "radio") options = [...document.querySelectorAll('input[type=radio][name="' + CSS.escape(el.name) + '"]')].map(labelFor).filter(Boolean);
    let label = (labelFor(el) || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
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
    out.push({ id, label, type, name: el.name || "", options, required: el.required });
  });
  // Custom <button> option groups (Ashby renders Yes/No as separate buttons).
  // Group by the question wrapper = nearest ancestor that contains a <label>.
  const optBtns = [...document.querySelectorAll('button[class*=option],button[class*=Option]')].filter((b) => getComputedStyle(b).display !== "none");
  const usedBtns = new Set();
  optBtns.forEach((btn) => {
    if (usedBtns.has(btn)) return;
    let anc = btn.parentElement;
    for (let k = 0; k < 6 && anc; k++) { if (anc.querySelector("label")) break; anc = anc.parentElement; }
    if (!anc) anc = btn.parentElement;
    const group = optBtns.filter((b) => anc.contains(b) && !usedBtns.has(b));
    group.forEach((b) => usedBtns.add(b));
    const l = anc.querySelector("label");
    const label = ((l && l.innerText) || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
    if (!label || !group.length) return;
    const id = "aa-" + i++; anc.setAttribute("data-aa-id", id);
    out.push({ id, label, type: "buttons", name: "", options: group.map((b) => b.innerText.trim()).filter(Boolean), required: false });
  });
  // Custom "Select..." dropdowns (react-select): target the control, resolve label robustly.
  const seenSel = new Set();
  const selCtrls = [...document.querySelectorAll("[class*=select__control],[class*=-control]")];
  [...document.querySelectorAll("div,span")].forEach((el) => { if (!el.children.length && /^select\.{2,3}$/i.test((el.textContent || "").trim())) { const c = el.closest("[class*=control]"); if (c) selCtrls.push(c); } });
  selCtrls.forEach((ctrl) => {
    if (seenSel.has(ctrl)) return; // dedupe within this call only (re-enumeration must re-detect)
    seenSel.add(ctrl);
    let label = "";
    const inp = ctrl.querySelector("input");
    if (inp && inp.getAttribute("aria-labelledby")) { const t = inp.getAttribute("aria-labelledby").split(/\s+/).map((id) => { const nn = document.getElementById(id); return nn ? nn.innerText : ""; }).join(" ").trim(); if (t) label = t; }
    if (!label && inp && inp.id) { const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); if (l && l.innerText.trim()) label = l.innerText.trim(); }
    if (!label) { let n = ctrl; for (let k = 0; k < 12 && n; k++) { const d = [...n.children].find((c) => c.tagName === "LABEL" && c.innerText.trim()); if (d) { label = d.innerText.trim(); break; } n = n.parentElement; } }
    label = (label || "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
    if (!label) return;
    const id = "aa-" + i++; ctrl.setAttribute("data-aa-id", id);
    out.push({ id, label, type: "customselect", name: "", options: [], required: false });
  });
  return out;
}

// ---------- fill ----------
function setNative(el, value) {
  try { el.focus(); } catch (e) {}
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true })); // some frameworks commit the value on blur
}
function dataURLtoFile(dataurl, filename) {
  const [meta, b64] = dataurl.split(","); const mime = (meta.match(/:(.*?);/) || [])[1] || "application/pdf";
  const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], filename, { type: mime });
}
async function fillFile(el, kind) {
  const doc = await send({ type: "getDoc", kind });
  if (!doc || !doc.dataUrl) return;
  const file = dataURLtoFile(doc.dataUrl, doc.name);
  const dt = new DataTransfer(); dt.items.add(file);
  try { el.files = dt.files; } catch (e) {}
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  // custom dropzone uploaders (Ashby/Workday) listen for drop, not input.files
  const zone = el.closest("[class*=rop],[class*=pload],[class*=ile],form") || el.parentElement;
  if (zone) ["dragenter", "dragover", "drop"].forEach((type) => {
    const d = new DataTransfer(); d.items.add(file);
    try { zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: d })); } catch (e) {}
  });
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
    const scope = (listId && document.getElementById(listId)) || document;
    const opts = [...scope.querySelectorAll("[role=option]")].filter((o) => o.offsetParent !== null && o.innerText.trim());
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
  return [...document.querySelectorAll('[class*=select__option],[role=option],[class*=menu] [class*=option]')]
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
async function fillCustomSelect(ctrl, value) {
  const want = value.trim().toLowerCase();
  ctrl.scrollIntoView({ block: "center" });
  openSelect(ctrl);
  for (let i = 0; i < 24; i++) {
    await sleep(120);
    const opts = visibleOptions();
    if (!opts.length && i === 4) mouseSeq(ctrl); // fallback open
    const match = opts.find((o) => o.innerText.trim().toLowerCase() === want)
      || opts.find((o) => { const t = o.innerText.trim().toLowerCase(); return t && (t.includes(want) || want.includes(t)); });
    if (match) { match.scrollIntoView({ block: "center" }); mouseSeq(match); return true; }
    if (opts.length && i > 8) break;
  }
  return false;
}
async function fillField(f, value) {
  const el = document.querySelector('[data-aa-id="' + f.id + '"]'); if (!el) return;
  if (f.type === "select") { const opt = closestOption(value, f.options) || value; const m = [...el.options].find((o) => o.text.trim() === opt); if (m) { el.value = m.value; el.dispatchEvent(new Event("change", { bubbles: true })); } }
  else if (f.type === "checkbox") { el.checked = /^(yes|true|1|on)$/i.test(value); el.dispatchEvent(new Event("change", { bubbles: true })); }
  else if (f.type === "radio") { const g = document.querySelectorAll('input[type=radio][name="' + CSS.escape(f.name) + '"]'); for (const r of g) { const lb = labelFor(r); if (lb && (lb.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(lb.toLowerCase()))) { r.click(); break; } } }
  else if (f.type === "file") { const l = f.label.toLowerCase(); if (/cover/.test(l)) await fillFile(el, "cover_letter"); else if (/resume|\bcv\b|curriculum/.test(l)) await fillFile(el, "resume"); }
  else if (f.type === "buttons") { const btns = [...el.querySelectorAll("button")]; const want = value.trim().toLowerCase(); const pick = btns.find((b) => b.innerText.trim().toLowerCase() === want) || btns.find((b) => { const t = b.innerText.trim().toLowerCase(); return t && (t.includes(want) || want.includes(t)); }); if (pick) pick.click(); }
  else if (f.type === "customselect") { await fillCustomSelect(el, value); }
  else if (isCombobox(el)) { await fillCombobox(el, value); }
  else setNative(el, value);
}

// ---------- autonomous learning ----------
// Capture the CURRENT value of every field (whatever you ended up with, typed or
// edited) into the answer bank. Runs on a timer and on page-leave, so it learns
// on its own with no action from you.
function readValue(f) {
  const el = document.querySelector('[data-aa-id="' + f.id + '"]'); if (!el) return "";
  if (f.type === "select") return el.value ? (el.options[el.selectedIndex] || {}).text || "" : "";
  if (f.type === "radio") { const g = document.querySelectorAll('input[type=radio][name="' + CSS.escape(f.name) + '"]'); for (const r of g) if (r.checked) return labelFor(r); return ""; }
  if (f.type === "checkbox") return el.checked ? "Yes" : "";
  if (f.type === "buttons") { const b = [...el.querySelectorAll("button")].find((x) => x.getAttribute("aria-pressed") === "true" || x.getAttribute("aria-checked") === "true" || /(_selected|selected|active)/.test(x.className)); return b ? b.innerText.trim() : ""; }
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
    let fields; try { fields = enumerate(); } catch (e) { return; }
    for (const f of fields) {
      if (f.type === "file") continue;
      const v = readValue(f);
      if (v && v.trim()) { send({ type: "learn", key: norm(f.label), label: f.label, value: v.trim(), ats: detectATS() }); noteLearned(document.querySelector('[data-aa-id="' + f.id + '"]'), f.label); }
    }
  }, 4000);
}

// ---------- resolve ----------
function resolve(profile, bank, f) {
  const sens = isSensitive(f.label);
  if (f.type === "file") {
    // markers; the actual file comes from the user's uploaded docs in storage (getDoc)
    const l = f.label.toLowerCase();
    if (/cover/.test(l)) return { value: "cover_letter", source: "profile", sensitive: false, review: false };
    if (/resume|\bcv\b|curriculum/.test(l)) return { value: "resume", source: "profile", sensitive: false, review: false };
    return { value: null, source: "needs_you", sensitive: false, review: true }; // additional attachments etc. -> you
  }
  const [pv] = valueForLabel(profile, f.label);
  // confident answers fill directly ON THE FORM (incl. dropdowns/button-groups)
  if (pv != null && ["text", "textarea", "email", "tel"].includes(f.type)) return { value: pv, source: "profile", sensitive: sens, review: false };
  if (pv != null && ["select", "radio", "checkbox", "buttons", "customselect"].includes(f.type)) { const o = closestOption(pv, f.options); if (o) return { value: o, source: "enum", sensitive: sens, review: false }; }
  const key = norm(f.label);
  if (bank[key]) return { value: bank[key].value, source: "cache", sensitive: sens, review: false };
  // fuzzy guess from the bank -> fill but surface for a quick check
  let best = null, s = 0; for (const k in bank) { const j = jaccard(f.label, bank[k].label || k); if (j > s) { s = j; best = bank[k]; } }
  if (best && s >= 0.86) return { value: best.value, source: "semantic", sensitive: sens, review: true };
  if (isFreetext(f)) return { value: null, source: "draft", sensitive: sens, review: true };
  return { value: null, source: "needs_you", sensitive: sens, review: true };
}

// ---------- docked side panel (visible on the page, Jobright-style) ----------
const PANEL_CSS = `
*{box-sizing:border-box;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
.wrap{display:flex;flex-direction:column;max-height:80vh;background:#fff;color:#0f172a;border-radius:16px;overflow:hidden;box-shadow:0 14px 44px rgba(2,6,23,.24);border:1px solid #e2e8f0}
.hd{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid #f1f5f9}
.brand{font-weight:750;font-size:14px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 3px #dcfce7}
.min{cursor:pointer;color:#94a3b8;font-size:18px;line-height:1;border:0;background:none;padding:2px 7px;border-radius:6px}
.min:hover{background:#f1f5f9}
.body{padding:14px 15px;overflow:auto}
.job{display:flex;gap:10px;align-items:flex-start;background:#f8fafc;border:1px solid #eef2f7;border-radius:12px;padding:11px 12px;margin-bottom:13px}
.jicon{width:30px;height:30px;border-radius:8px;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:0 0 auto}
.co{font-weight:650;font-size:13px;line-height:1.3}
.ti{color:#64748b;font-size:12px;margin-top:2px;line-height:1.35}
.btn{width:100%;background:#16a34a;color:#fff;border:0;border-radius:11px;padding:13px;font-weight:700;font-size:14px;cursor:pointer;transition:background .15s,transform .05s}
.btn:hover{background:#15803d}.btn:active{transform:scale(.99)}
.summary{display:flex;gap:8px;margin:13px 0 2px;flex-wrap:wrap}
.chip{font-size:11.5px;font-weight:650;border-radius:20px;padding:4px 11px}
.chip.ok{background:#ecfdf5;color:#047857}.chip.warn{background:#fff7ed;color:#c2410c}
.status{color:#64748b;font-size:12px;margin:11px 0 2px}
.learned{font-size:12px;color:#16a34a;font-weight:650;margin:8px 0 2px;min-height:16px}
.row{border:1px solid #eef2f7;border-left:3px solid #cbd5e1;border-radius:10px;padding:11px;margin-bottom:9px}
.row.sens{border-left-color:#ef4444;background:#fffafa}
.row.draft{border-left-color:#3b82f6}
.tag{font-size:9.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:#94a3b8}
.row.sens .tag{color:#ef4444}.row.draft .tag{color:#3b82f6}
.lbl{font-weight:650;font-size:12.5px;margin:4px 0 7px;word-break:break-word;line-height:1.35}
.fld{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:8px;font-size:13px;color:#0f172a;background:#fff;outline:none}
.fld:focus{border-color:#16a34a;box-shadow:0 0 0 3px #dcfce7}
textarea.fld{resize:vertical;min-height:34px}
.acts{display:flex;gap:7px;margin-top:8px}
.apply{flex:1;background:#0f172a;color:#fff;border:0;border-radius:8px;padding:8px;font-weight:600;font-size:12.5px;cursor:pointer}
.apply:hover{background:#1e293b}
.draftb{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:8px;padding:8px 11px;cursor:pointer;font-weight:600;font-size:12.5px}
.draftb:hover{background:#dbeafe}
.empty{color:#94a3b8;font-size:12.5px;text-align:center;padding:14px 0}
`;
let AA_SHADOW = null;
function rowHTML(it) {
  const cls = it.sensitive ? "sens" : (it.source === "draft" ? "draft" : "");
  const tag = it.sensitive ? "Review" : it.source;
  const inner = (it.options && it.options.length)
    ? `<select class="fld" data-edit="${it.id}"><option value="">— choose —</option>${it.options.map((o) => `<option${o === it.value ? " selected" : ""}>${o}</option>`).join("")}</select>`
    : `<textarea class="fld" data-edit="${it.id}" rows="${it.type === "textarea" ? 4 : 1}">${it.value || ""}</textarea>`;
  return `<div class="row ${cls}" data-row="${it.id}"><div class="tag">${tag}</div><div class="lbl">${it.label}</div>${inner}<div class="acts"><button class="apply" data-apply="${it.id}">Apply</button>${it.source === "draft" ? `<button class="draftb" data-redraft="${it.id}">Redraft</button>` : ""}</div></div>`;
}
function renderResults(items, autoCount) {
  const sh = AA_SHADOW; if (!sh) return;
  const st = sh.getElementById("aa-status");
  if (st) st.innerHTML = `<div class="summary"><span class="chip ok">✓ ${autoCount} filled</span>${items.length ? `<span class="chip warn">${items.length} need you</span>` : ""}</div>`;
  const box = sh.getElementById("aa-results");
  box.innerHTML = items.length ? items.map(rowHTML).join("") : '<div class="empty">All set — nothing needs you.</div>';
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  box.querySelectorAll("[data-apply]").forEach((b) => (b.onclick = async () => { const id = b.dataset.apply; const v = box.querySelector(`[data-edit="${id}"]`).value; await fillField(byId[id], v); await send({ type: "learn", key: norm(byId[id].label), label: byId[id].label, value: v, ats: detectATS() }); box.querySelector(`[data-row="${id}"]`).style.opacity = .5; b.textContent = "✓ Applied"; }));
  box.querySelectorAll("[data-redraft]").forEach((b) => (b.onclick = async () => { const id = b.dataset.redraft; const ta = box.querySelector(`[data-edit="${id}"]`); ta.value = "drafting…"; const r = await send({ type: "draft", question: byId[id].label, jd: CURRENT_JD, examples: topBank(byId[id].label, 5) }); ta.value = r.text || ("[" + (r.error || "error") + "]"); }));
}
function mountPanel() {
  if (document.getElementById("aa-root") || !document.body) return;
  let jd = { company: "", title: "" }; try { jd = extractJD(); } catch (e) {}
  const co = jd.company || detectATS() || "Application";
  const host = document.createElement("div"); host.id = "aa-root";
  host.style.cssText = "position:fixed;bottom:18px;right:18px;width:332px;z-index:2147483647";
  const sh = host.attachShadow({ mode: "open" }); AA_SHADOW = sh;
  sh.innerHTML = `<style>${PANEL_CSS}</style><div class="wrap"><div class="hd"><span class="brand"><span class="dot"></span>AutoApply</span><button class="min" id="aa-min">–</button></div><div class="body" id="aa-body"><div class="job"><div class="jicon">${(co[0] || "A").toUpperCase()}</div><div><div class="co">${co}</div><div class="ti">${jd.title || ""}</div></div></div><button class="btn" id="aa-run">⚡ Autofill this page</button><div class="status" id="aa-status">Ready</div><div class="learned" id="aa-learned"></div><div id="aa-results"></div></div></div>`;
  document.body.appendChild(host);
  startPassiveLearning(); // learn from manual page fills, even before Autofill
  sh.getElementById("aa-run").onclick = () => run().catch((e) => console.warn("[aa]", e));
  sh.getElementById("aa-min").onclick = () => { const bd = sh.getElementById("aa-body"); bd.style.display = bd.style.display === "none" ? "block" : "none"; };
  (async () => { const p = await send({ type: "getProfile" }); const doc = await send({ type: "getDoc", kind: "resume" }); const st = sh.getElementById("aa-status"); if (st && st.textContent === "Ready") st.textContent = (p ? "✓ profile" : "✗ profile") + " · " + (doc ? "✓ resume ready" : "✗ no resume"); })();
}

// ---------- run ----------
async function run() {
  const ats = detectATS(); if (!ats) return alert("Not a recognized application page.");
  const profile = await send({ type: "getProfile" });
  const bank = await send({ type: "getBank" });
  CURRENT_BANK = bank;
  CURRENT_JD = extractJD();
  const setStatus = (t) => { const st = AA_SHADOW && AA_SHADOW.getElementById("aa-status"); if (st) st.innerHTML = t; };

  const fields = enumerate();
  // read options for custom dropdowns so the LLM can pick exact options
  setStatus("Reading the form…");
  for (const f of fields) if (f.type === "customselect") { try { f.options = await readSelectOptions(document.querySelector('[data-aa-id="' + f.id + '"]')); } catch (e) {} }

  // LLM = universal mapper: understands each question + maps to your data (any ATS)
  setStatus("Understanding questions with AI…");
  let llm = {}; let noKey = false;
  const slim = fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: (f.options || []).slice(0, 25) }));
  const r = await send({ type: "mapFields", fields: slim, jd: CURRENT_JD });
  if (r && r.map) llm = r.map; else if (r && r.error === "no_key") noKey = true;

  const review = []; let auto = 0;
  for (const f of fields) {
    // If YOU already filled/selected this field, NEVER overwrite it. Just learn from it.
    const cur = (() => { try { return readValue(f); } catch (e) { return ""; } })();
    if (cur && String(cur).trim()) {
      if (f.type !== "file") {
        send({ type: "learn", key: norm(f.label), label: f.label, value: String(cur).trim(), ats });
        noteLearned(document.querySelector('[data-aa-id="' + f.id + '"]'), f.label);
      }
      continue; // skip empty-only: leave your selection untouched
    }
    const a = resolve(profile, bank, f); // exact profile facts (links/email), enum, learned answers
    let value = null, source = null;
    // 1. deterministic: your profile facts AND what you taught it both beat the AI guess
    if (a.value != null && !a.review) { value = a.value; source = a.source; }
    // 2. else the AI maps it (custom questions the profile does not cover)
    if (value == null) { const lv = llm[f.id]; if (lv != null && String(lv).trim() !== "" && String(lv).toLowerCase() !== "null") { value = String(lv); source = "ai"; } }
    if (value == null) {
      // nothing confident: leave it on the form (you fill, it learns). Review only AI drafts.
      if (f.type === "checkbox") continue;
      if (a.source === "draft" || (a.value != null && String(a.value).trim() !== "")) {
        review.push({ ...f, value: a.value, source: a.source, sensitive: a.sensitive });
      }
      continue;
    }
    try { await fillField(f, value); auto++; } catch (e) { console.warn("[aa] fill failed:", f.label, e); }
  }
  // draft any remaining free-text from resume + JD
  for (const it of review) if (it.source === "draft" && !it.value) { const dr = await send({ type: "draft", question: it.label, jd: CURRENT_JD, examples: topBank(it.label, 5) }); it.value = dr.error ? "" : dr.text; if (it.value) await fillField(it, it.value); }
  renderResults(review, auto);
  if (noKey) setStatus('<span style="color:#c2410c">⚠ Add your API key in the popup so AI can map every question</span>');
  else if (r && r.error) setStatus('<span style="color:#c2410c">⚠ AI error: ' + String(r.error).slice(0, 70) + '</span>');
  else if (r && r.map) setStatus('<span style="color:#16a34a">✓ AI mapped ' + Object.values(r.map).filter((v) => v != null && v !== "").length + ' questions</span>');
  startPassiveLearning();
}

// Mount one panel, only in the frame that actually holds the form.
function shouldMount() { return detectATS() && document.querySelectorAll("input,textarea,select").length >= 3; }
if (detectATS()) startPassiveLearning(); // learn even if the panel never mounts
if (shouldMount()) mountPanel();
setInterval(() => { if (shouldMount() && !document.getElementById("aa-root")) mountPanel(); }, 3000);
