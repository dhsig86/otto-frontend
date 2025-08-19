/*
  ROBOTTO — Tele-ENT Triage Orchestrator
  File: robotto.js
  Version: 2.1.4 (2025-08-19)

  O que muda nesta versão:
  - Carregamento resiliente das regras (404 não quebra o fluxo).
  - Inferência de domínio quando ausente.
  - Integra diagnostics.js (window.localDifferentials) quando disponível, com gaps.questions.
  - Fallback local por priors caso não exista diagnostics.js / regras.
  - Chamada ao backend /api/triage (gpt-5-nano; temp=1), sem X-OTTO-KEY.
  - AbortController com reason 'superseded' para evitar AbortError ruidoso.
*/

(function () {
  const CONFIG = {
    BACKEND_API_URL: (window.ROB_BACKEND_API_URL || "https://<your-heroku-app>.herokuapp.com"),
    ENDPOINT: "/api/triage",
    MODEL_HINT: "gpt-5-nano",
    TIMEOUT_MS: 120000,
    CONFIDENCE_THRESHOLD: 0.62,
    STREAM: false,          // /api/triage retorna JSON (sem SSE)
    MAX_TOKENS: 700,
    TEMPERATURE: 1,
    VERSION: "2.1.4",
  };

  // -----------------------------
  // Utils
  // -----------------------------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const uniq = (arr) => Array.from(new Set(Array.isArray(arr) ? arr : []));
  const hasText = (s) => typeof s === "string" && s.trim().length > 0;

  function inferDomain(payload) {
    const t = `${payload.freeText || ""} ${(payload.symptoms || []).join(" ")}`.toLowerCase();
    if (/ouvid|otalg|otite|timp/.test(t)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus/.test(t)) return "nariz";
    if (/gargant|faring|larin|amigdal/.test(t)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(t)) return "pescoco";
    return "ouvido";
  }

  const REDFLAG_PATTERNS = [
    /falta\s*de\s*ar|dispneia/i,
    /dificuldade\s*para\s*respirar|estridor/i,
    /dor\s*muito\s*intensa|insuport[aá]vel/i,
    /sangramento\s*(volumoso|intenso|ativo)/i,
    /rigidez\s*de\s*pesc[oó]co|meningismo/i,
    /confus[aã]o|desmaio|alter[aç][ã]o neurol[oó]gica/i,
  ];
  function redFlagsFromText(text) {
    const t = String(text || "");
    const hits = [];
    for (const re of REDFLAG_PATTERNS) if (re.test(t)) hits.push(re.source);
    return { any: hits.length > 0, patterns: hits };
  }

  const CACHE = { rules: null, rulesUrl: null, last: null, llmAborter: null };

  // -----------------------------
  // Regras (tolerante a erro)
  // -----------------------------
  async function loadRules(url) {
    if (!url) return {};
    if (CACHE.rules && CACHE.rulesUrl === url) return CACHE.rules;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      CACHE.rules = json;
      CACHE.rulesUrl = url;
      return json;
    } catch (e) {
      console.warn(`rules: falha ao carregar (${url}):`, e);
      return {}; // segue sem regras
    }
  }

  // -----------------------------
  // Fallback local por priors
  // -----------------------------
  function localByPriors(payload, rules) {
    const domain = payload.domain || inferDomain(payload);
    const dxList = (rules?.domains?.[domain]?.dx) || [];
    const scored = [];
    for (const dx of dxList) {
      const prior = clamp(Number(dx?.prior ?? 0.1), 0.001, 0.95);
      scored.push({ dx: dx?.name || dx?.dx || "dx", norm: prior });
    }
    scored.sort((a, b) => b.norm - a.norm);
    const confidence = scored[0]?.norm || 0;
    return {
      payload,
      list: scored,
      top3: scored.slice(0, 3),
      confidence,
      redFlags: redFlagsFromText(payload.freeText),
      gaps: { questions: [], unknownSx: [] },
      rulesVersion: rules?.version || "unknown",
    };
  }

  // -----------------------------
  // Motor local (usa diagnostics.js se presente)
  // -----------------------------
  function localEngine(payload, rules) {
    const p = { ...(payload || {}) };
    p.freeText = p.freeText || "";
    p.symptoms = uniq(p.symptoms);
    if (!p.domain) p.domain = inferDomain(p);

    if (typeof window.localDifferentials === "function") {
      try {
        const out = window.localDifferentials(p, rules) || {};
        const list = Array.isArray(out.list) ? out.list : [];
        const top3 = list.slice(0, 3).map(d => ({
          dx: d.dx,
          norm: clamp(Number(d.probability || 0), 0, 1)
        }));
        const confidence = clamp(Number(out.confidence || top3[0]?.norm || 0), 0, 1);
        const gaps = out.gaps && typeof out.gaps === "object"
          ? { questions: uniq(out.gaps.questions || []), unknownSx: uniq(out.gaps.unknownSx || []) }
          : { questions: [], unknownSx: [] };
        const redFlags = out.redFlags || redFlagsFromText(p.freeText);
        return { payload: p, list, top3, confidence, gaps, redFlags, rulesVersion: rules?.version || "unknown" };
      } catch (e) {
        console.warn("diagnostics.localDifferentials falhou — usando priors. Erro:", e);
      }
    }

    return localByPriors(p, rules);
  }

  // -----------------------------
  // Backend /api/triage
  // -----------------------------
  async function callLLMBackendForTriage(payload) {
    // Cancela requisição/stream anterior, se houver
    if (CACHE.llmAborter) {
      try { CACHE.llmAborter.abort('superseded'); } catch {}
    }
    const aborter = new AbortController();
    CACHE.llmAborter = aborter;

    const url = `${CONFIG.BACKEND_API_URL}${CONFIG.ENDPOINT}`;
    const body = {
      free_text: payload.freeText || "",
      age: payload.age ?? null,
      sex: payload.sex ?? null,
      duration: payload.duration ?? null,
      symptoms: payload.symptoms || [],
      comorbidities: payload.comorbidities || [],
      medications: payload.medications || [],
      red_flags_reported: payload.red_flags_reported || [],
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: aborter.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
      return await res.json();
    } catch (err) {
      if (err && err.name === "AbortError") {
        const reason = (aborter.signal && aborter.signal.reason) || "";
        if (reason === "superseded") return { _aborted: true };
      }
      console.warn("Backend error:", err);
      return { ok: false, error: String(err) };
    } finally {
      if (CACHE.llmAborter === aborter) CACHE.llmAborter = null;
    }
  }

  // -----------------------------
  // Runner
  // -----------------------------
  async function run(payload, options = {}) {
    const { rulesUrl, forceLLM = false } = options;

    const rules = await loadRules(rulesUrl);
    const local = localEngine(payload, rules);

    const needLLM =
      forceLLM ||
      local.confidence < CONFIG.CONFIDENCE_THRESHOLD ||
      (local.gaps?.unknownSx?.length > 0) ||
      (local.redFlags?.any);

    let backendResp = null;
    if (needLLM && CONFIG.BACKEND_API_URL?.startsWith("http")) {
      backendResp = await callLLMBackendForTriage(local.payload);
    }

    const result = { ok: true, local, backend: backendResp };
    CACHE.last = result;
    return result;
  }

  // -----------------------------
  // Public API
  // -----------------------------
  function last() { return CACHE.last; }
  function setConfig(partial) { Object.assign(CONFIG, partial || {}); }

  window.ROBOTTO = { run, loadRules, setConfig, last };

  // -----------------------------
  // Self-test em dev
  // -----------------------------
  if (window && window.location && /localhost|127\.0\.0\.1/.test(window.location.host)) {
    (async () => {
      try {
        const demoPayload = {
          domain: null,
          age: 28,
          sex: "F",
          duration: "2 dias",
          symptoms: ["febre", "dor_de_ouvido"],
          freeText: "dor que piora ao deitar. Sem tontura."
        };
        const demo = await run(demoPayload, { rulesUrl: "./rules_otorrino.json", forceLLM: false });
        console.debug("ROBOTTO demo result:", demo);
      } catch (e) {
        console.warn("ROBOTTO self-test warning:", e);
      }
    })();
  }
})();
// ---------------- Fim do módulo robotto.js ----------------
// Fim do módulo robotto.js