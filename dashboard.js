// Applications dashboard. Reads/writes chrome.storage.local["applications"]
// (written by content.js on every Autofill run and on Submit clicks).

const $ = (id) => document.getElementById(id);
const STATUSES = ["filled", "applied", "interview", "offer", "rejected"];

async function loadApps() {
  return (await chrome.storage.local.get("applications")).applications || {};
}
async function saveApps(apps) {
  await chrome.storage.local.set({ applications: apps });
}
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function rowHTML(key, a) {
  const opts = STATUSES.map((s) => `<option value="${s}"${a.status === s ? " selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("");
  // applied with no movement for 7+ days -> nudge to follow up
  const since = a.statusTs || a.appliedTs || a.ts || 0;
  const stale = a.status === "applied" && Date.now() - since > 7 * 864e5;
  return `<tr data-key="${esc(key)}">
    <td class="meta">${fmtDate(a.ts)}</td>
    <td><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.company || "(unknown company)")}</a><div class="role">${esc(a.title || "")}</div></td>
    <td><span class="ats">${esc(a.ats || "-")}</span></td>
    <td class="meta">${a.filled != null ? a.filled + " fields" : "-"}</td>
    <td><select class="stsel st-${esc(a.status || "filled")}" data-status="${esc(key)}">${opts}</select>${stale ? '<span class="followup" title="No status change for over a week">⏰ follow up</span>' : ""}</td>
    <td><button class="del" data-del="${esc(key)}" title="Remove">✕</button></td>
  </tr>`;
}

async function render() {
  const apps = await loadApps();
  const q = ($("q").value || "").toLowerCase();
  const sf = $("statusFilter").value;
  const entries = Object.entries(apps)
    .sort((x, y) => (y[1].ts || 0) - (x[1].ts || 0))
    .filter(([, a]) => !sf || (a.status || "filled") === sf)
    .filter(([, a]) => !q || `${a.company} ${a.title} ${a.ats}`.toLowerCase().includes(q));

  const all = Object.values(apps);
  $("s-total").textContent = all.length;
  $("s-applied").textContent = all.filter((a) => ["applied", "interview", "offer"].includes(a.status)).length;
  $("s-week").textContent = all.filter((a) => (a.ts || 0) > Date.now() - 7 * 864e5).length;
  $("s-fields").textContent = all.reduce((n, a) => n + (a.filled || 0), 0);

  const fApplied = all.filter((a) => ["applied", "interview", "offer"].includes(a.status)).length;
  const fInterview = all.filter((a) => ["interview", "offer"].includes(a.status)).length;
  const fOffer = all.filter((a) => a.status === "offer").length;
  $("funnel").innerHTML = [
    ["Filled", all.length], ["Applied", fApplied], ["Interview", fInterview], ["Offer", fOffer],
  ].map(([l, n]) => `<div class="fstage"><div class="fn">${n}</div><div class="fl">${l}</div></div>`)
    .join('<div class="farrow">→</div>');

  $("rows").innerHTML = entries.map(([k, a]) => rowHTML(k, a)).join("");
  $("empty").style.display = entries.length ? "none" : "block";

  document.querySelectorAll("[data-status]").forEach((sel) => {
    sel.onchange = async () => {
      const apps2 = await loadApps();
      if (apps2[sel.dataset.status]) {
        apps2[sel.dataset.status].status = sel.value;
        apps2[sel.dataset.status].statusTs = Date.now();
        await saveApps(apps2); render();
      }
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const apps2 = await loadApps();
      delete apps2[b.dataset.del];
      await saveApps(apps2); render();
    };
  });
}

$("exportLog").onclick = async () => {
  const { runLog = [] } = await chrome.storage.local.get("runLog");
  const blob = new Blob([JSON.stringify(runLog, null, 2)], { type: "application/json" });
  const u = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = u; link.download = "autoapply-debug-log.json"; link.click();
  URL.revokeObjectURL(u);
};

$("q").addEventListener("input", render);
$("statusFilter").addEventListener("change", render);
$("export").onclick = async () => {
  const apps = await loadApps();
  const head = ["date", "company", "title", "platform", "status", "fields_filled", "url"];
  const lines = [head.join(",")].concat(Object.values(apps).map((a) =>
    [fmtDate(a.ts), a.company, a.title, a.ats, a.status, a.filled ?? "", a.url]
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")
  ));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const u = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = u; link.download = "autoapply-applications.csv"; link.click();
  URL.revokeObjectURL(u);
};

render();
