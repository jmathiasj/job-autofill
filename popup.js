const $ = (id) => document.getElementById(id);

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
