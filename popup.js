const $ = (id) => document.getElementById(id);

$("dash").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });

// "Use local Claude" toggle: route AI calls through the local bridge (subscription)
const BRIDGE = "http://127.0.0.1:8765/";
async function pingBridge() {
  const s = $("localStatus");
  try {
    const r = await fetch(BRIDGE, { method: "GET" });
    if (r.ok) { s.textContent = "(bridge running ✓)"; s.style.color = "#047857"; return; }
  } catch (e) {}
  s.textContent = $("local").checked ? "(bridge not reachable - start it)" : "(subscription, via bridge)";
  s.style.color = $("local").checked ? "#b45309" : "";
}
chrome.storage.local.get("useLocalClaude", (v) => {
  const on = !!(v && v.useLocalClaude);
  $("local").checked = on;
  $("localHint").style.display = on ? "block" : "none";
  pingBridge();
});
$("local").onchange = () => {
  const on = $("local").checked;
  chrome.storage.local.set({ useLocalClaude: on });
  $("localHint").style.display = on ? "block" : "none";
  pingBridge();
};

// setup checklist: profile / resume / API key (or local bridge) at a glance
chrome.runtime.sendMessage({ type: "health" }, (h) => {
  if (!h) return;
  const chip = (ok, label) =>
    `<span style="font-size:11px;font-weight:650;border-radius:6px;padding:3px 9px;border:1px solid ${ok ? "#d1fae5" : "#fde68a"};background:${ok ? "#ecfdf5" : "#fffbeb"};color:${ok ? "#047857" : "#b45309"}">${ok ? "✓" : "•"} ${label}</span>`;
  const localOn = $("local").checked;
  $("check").innerHTML =
    chip(!!h.profileName, h.profileName ? "Profile: " + h.profileName.split(" ")[0] : "Profile missing") +
    chip(h.hasResume, h.hasResume ? "Resume ready" : "No resume") +
    chip(h.hasKey || localOn, localOn ? "Local Claude" : (h.hasKey ? "AI key set" : "No API key"));
});

function readAsDataURL(file) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}

// Load saved settings (or the bundled template) into the form.
(async () => {
  const { anthropicKey, docs = {}, profileOverride } = await chrome.storage.local.get(["anthropicKey", "docs", "profileOverride"]);
  if (anthropicKey) $("key").value = anthropicKey;
  if (docs.resume) $("resumeName").textContent = "✓ " + docs.resume.name;
  if (docs.cover_letter) $("coverName").textContent = "✓ " + docs.cover_letter.name;
  if (profileOverride) {
    $("profile").value = JSON.stringify(profileOverride, null, 2);
  } else {
    const tmpl = await fetch(chrome.runtime.getURL("profile.json")).then((r) => r.json());
    $("profile").value = JSON.stringify(tmpl, null, 2);
  }
})();

$("loadTemplate").onclick = async () => {
  const tmpl = await fetch(chrome.runtime.getURL("profile.json")).then((r) => r.json());
  $("profile").value = JSON.stringify(tmpl, null, 2);
  $("status").innerHTML = '<span class="muted">Template loaded. Fill in your details and Save.</span>';
};

$("format").onclick = () => {
  try {
    const obj = JSON.parse($("profile").value);
    $("profile").value = JSON.stringify(obj, null, 2);
    $("status").innerHTML = '<span class="ok">Valid JSON ✓</span>';
  } catch (e) {
    $("status").innerHTML = '<span class="err">Invalid JSON: ' + e.message + '</span>';
  }
};

$("save").onclick = async () => {
  // profile
  let profileOverride = null;
  const raw = $("profile").value.trim();
  if (raw) {
    try { profileOverride = JSON.parse(raw); }
    catch (e) { $("status").innerHTML = '<span class="err">Profile JSON invalid: ' + e.message + '</span>'; return; }
  }
  // documents
  const cur = await chrome.storage.local.get("docs");
  const docs = cur.docs || {};
  const rf = $("resume").files[0];
  if (rf) docs.resume = { name: rf.name, dataUrl: await readAsDataURL(rf) };
  const cf = $("cover").files[0];
  if (cf) docs.cover_letter = { name: cf.name, dataUrl: await readAsDataURL(cf) };

  await chrome.storage.local.set({ anthropicKey: $("key").value.trim(), docs, profileOverride });
  $("status").innerHTML = '<span class="ok">Saved.</span>';
  if (docs.resume) $("resumeName").textContent = "✓ " + docs.resume.name;
  if (docs.cover_letter) $("coverName").textContent = "✓ " + docs.cover_letter.name;
};
