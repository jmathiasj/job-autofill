// Service worker: profile delivery, answer-bank storage, and the LLM calls
// (universal field mapping + resume-grounded essay drafting).

const RAG_MODEL = "claude-sonnet-4-6"; // Claude model for mapping + drafting

// Bundled documents (your resume/cover letter). A user can override via the popup.
const BUNDLED = { resume: "docs/resume.pdf", cover_letter: "docs/cover_letter.pdf" };
const DOC_NAMES = { resume: "Jenell Mathias Resume.pdf", cover_letter: "Cover_Letter_General.pdf" };
function abToBase64(buf) {
  let bin = ""; const bytes = new Uint8Array(buf); const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
async function bundledDoc(kind) {
  const path = BUNDLED[kind]; if (!path) return null;
  try {
    const buf = await fetch(chrome.runtime.getURL(path)).then((r) => r.arrayBuffer());
    return { name: DOC_NAMES[kind], dataUrl: "data:application/pdf;base64," + abToBase64(buf) };
  } catch (e) { return null; }
}

function isEmptyVal(v) { return v == null || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === ""))); }
// Deep-merge so EMPTY popup fields fall back to the bundled profile (never wipe real data).
function deepMerge(base, over) {
  if (Array.isArray(over)) return (over.length && !over.every((x) => x === "")) ? over : base;
  if (over && typeof over === "object") {
    const out = Object.assign({}, base);
    for (const k in over) {
      const ov = over[k];
      if (ov && typeof ov === "object" && !Array.isArray(ov)) out[k] = deepMerge((base && base[k]) || {}, ov);
      else out[k] = isEmptyVal(ov) ? (base ? base[k] : ov) : ov;
    }
    return out;
  }
  return isEmptyVal(over) ? base : over;
}
async function loadProfile() {
  // bundled profile (your data) + non-empty overrides saved from the popup
  const base = await fetch(chrome.runtime.getURL("profile.json")).then((r) => r.json());
  const { profileOverride } = await chrome.storage.local.get("profileOverride");
  return profileOverride ? deepMerge(base, profileOverride) : base;
}

// Compact resume context for grounding. Small enough to send every time.
function resumeContext(p) {
  const exp = (p.experience || [])
    .map((e) => `${e.company} (${e.location || ""}): ` + (e.highlights || []).join(" "))
    .join("\n");
  const edu = (p.education || [])
    .map((e) => `${e.degree} ${e.field}, ${e.school} (GPA ${e.gpa})`)
    .join("; ");
  const skills = Object.values(p.skills || {}).flat().join(", ");
  const proj = (p.projects_publications || [])
    .map((x) => `${x.name}: ${x.summary}${x.publication ? " " + x.publication : ""}`)
    .join("\n");
  const narr = Object.entries(p.narrative || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return [
    "CANDIDATE RESUME FACTS (never invent beyond these):",
    "EXPERIENCE:\n" + exp,
    "EDUCATION: " + edu,
    "SKILLS: " + skills,
    "PROJECTS/PUBLICATIONS:\n" + proj,
    "NARRATIVE SNIPPETS:\n" + narr,
  ].join("\n\n");
}

async function draftAnswer(question, jd, examples) {
  const { anthropicKey } = await chrome.storage.local.get("anthropicKey");
  if (!anthropicKey) return { error: "no_key" };
  const p = await loadProfile();
  const context = resumeContext(p);
  const jdText = jd
    ? `JOB CONTEXT (tailor "why" answers to this specific company/role):\n` +
      `Company: ${jd.company || "?"}\nRole: ${jd.title || "?"}\n` +
      `Job description:\n${(jd.description || "").slice(0, 4000)}`
    : "(no job description available; answer from resume facts only)";
  const priorText = examples && examples.length
    ? "ANSWERS YOU'VE PREVIOUSLY GIVEN (reuse or adapt when the question is similar; " +
      "keep this voice and style):\n" +
      examples.map((e) => `Q: ${e.q}\nA: ${e.a}`).join("\n\n")
    : "(no prior answers yet)";
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: [
      {
        type: "text",
        text:
          "You draft concise, specific, first-person answers to job-application " +
          "questions, grounded ONLY in the candidate resume facts provided. For 'why " +
          "this company/role' questions, connect SPECIFIC points from the job " +
          "description to SPECIFIC facts in the resume (real projects, skills, scale). " +
          "Do not fabricate employers, metrics, titles, or skills, and do not invent " +
          "company facts beyond the job description. 2-5 sentences. No fluff, no em dashes.",
      },
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: `${jdText}\n\n${priorText}\n\nQuestion: ${question}\n\nWrite my answer, tailored to this company and role using my resume facts and consistent with my prior answers.` },
    ],
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (j.error) return { error: j.error.message || "api_error" };
    const text = (j.content || []).map((b) => b.text || "").join("").trim();
    return { text };
  } catch (e) {
    return { error: String(e) };
  }
}

// Universal field mapper: the LLM understands each question (label + type +
// dropdown options) and maps it to the candidate's data. Works on ANY form.
async function mapFields(fields, jd) {
  const { anthropicKey } = await chrome.storage.local.get("anthropicKey");
  if (!anthropicKey) return { error: "no_key" };
  const p = await loadProfile();
  const { answerBank = {} } = await chrome.storage.local.get("answerBank");
  const priors = Object.values(answerBank).slice(0, 50).map((e) => `- ${e.label}: ${e.value}`).join("\n");
  const facts = JSON.stringify({
    identity: p.identity, links: p.links, work_eligibility: p.work_eligibility,
    logistics: p.logistics, eeo: p.eeo_voluntary, education: p.education,
  });
  const resume = resumeContext(p);
  const sys =
    "You map job-application form fields to a candidate's data. For EACH field, decide the value to fill. " +
    "Rules: (1) If the field has options (a dropdown), return the EXACT option string that best fits the candidate. " +
    "(2) For text fields, return the candidate's answer. " +
    "(3) Return null for consent checkboxes, legal acknowledgements, signatures, e-sign, and anything you cannot determine from the data. " +
    "(4) Infer reasonably: e.g. 'years of experience' -> pick the option matching ~4 years; 'authorized to work' -> Yes; map skills/languages to what the resume shows. " +
    "(5) For a work-experience 'Role Description' / 'Description' field, identify WHICH role it belongs to using the nearby Job Title + Company values, then output THAT role's resume bullet points VERBATIM (from experience[].highlights) — each bullet on its own line prefixed with '- '. Do NOT paraphrase, summarize, or merge roles. " +
    "(6) For date fields (From/To, formatted MM/YYYY): use the matching role's start/end as MM/YYYY (e.g. '02/2023'). If the role is current, leave the To/end value null. NEVER output 'MM', a partial date, or a guessed year. " +
    "(7) NEVER answer a free-text field (full name, compensation, 'why are you a fit', referral name) with 'Yes' or 'No'. Those need real text or null. Only Yes/No-style questions get Yes/No. " +
    "Use the profile facts, resume, and prior answers. Output ONLY a JSON object mapping each field id to a string value or null. No prose, no code fences.";
  const usr =
    `CANDIDATE PROFILE:\n${facts}\n\nRESUME:\n${resume}\n\nPRIOR ANSWERS:\n${priors || "(none yet)"}\n\n` +
    `JOB: ${(jd && jd.company) || ""} - ${(jd && jd.title) || ""}\n\n` +
    `FORM FIELDS (JSON):\n${JSON.stringify(fields)}\n\nReturn {"<id>": "<value or null>"} for every id.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: RAG_MODEL, max_tokens: 2000, system: sys, messages: [{ role: "user", content: usr }] }),
    });
    const j = await res.json();
    if (j.error) return { error: j.error.message || "api_error" };
    let text = (j.content || []).map((b) => b.text || "").join("").trim();
    const m = text.match(/\{[\s\S]*\}/); if (m) text = m[0];
    return { map: JSON.parse(text) };
  } catch (e) {
    return { error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "getProfile") reply(await loadProfile());
    else if (msg.type === "getBank")
      reply((await chrome.storage.local.get("answerBank")).answerBank || {});
    else if (msg.type === "learn") {
      const { answerBank = {} } = await chrome.storage.local.get("answerBank");
      answerBank[msg.key] = { value: msg.value, label: msg.label, ats: msg.ats };
      await chrome.storage.local.set({ answerBank });
      reply({ ok: true });
    } else if (msg.type === "getDoc") {
      const docs = (await chrome.storage.local.get("docs")).docs || {};
      reply(docs[msg.kind] || (await bundledDoc(msg.kind)));
    } else if (msg.type === "draft") {
      reply(await draftAnswer(msg.question, msg.jd, msg.examples));
    } else if (msg.type === "mapFields") {
      reply(await mapFields(msg.fields, msg.jd));
    } else reply({ error: "unknown" });
  })();
  return true; // async
});
