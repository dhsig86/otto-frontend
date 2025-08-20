/*
  ROBOTTO — Tele-ENT Triage Orchestrator
  File: robotto.js
  Version: 2.2.0 (2025-08-19)
*/
(function () {
  const CONFIG = {
    BACKEND_API_URL: (window.ROB_BACKEND_API_URL || "https://<your-heroku-app>.herokuapp.com"),
    ENDPOINT: "/api/triage",
    MODEL_HINT: "gpt-5-nano",
    TIMEOUT_MS: 120000,
    CONFIDENCE_THRESHOLD: 0.62,
    STREAM: false,
    MAX_TOKENS: 700,
    TEMPERATURE: 1,
  };

  // ----------------- Utils -----------------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : a));
  const norm = (s) => (s || "").toLowerCase();

  function withTimeout(promise, ms, label = "timeout") {
    let t;
    const timeout = new Promise((_, rej) => t = setTimeout(() => rej(new Error(label)), ms));
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function inferDomain(payload) {
    const t = norm(payload?.freeText || "");
    if (/ouvid|otalg|otit|timp|orelha/.test(t)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus|epistax/.test(t)) return "nariz";
    if (/gargant|faring|larin|amigdal|odinofag/.test(t)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(t)) return "pescoco";
    return payload?.domain || "garganta";
  }

  function parseDurationDaysFrom(payload) {
    // Preferir parser já feito no diagnostics/app-ui
    if (payload?.extras?.parsed?.durationDays != null) return payload.extras.parsed.durationDays;

    const d = String(payload?.duration || payload?.duration_norm || "").toLowerCase();
    const mISO = d.match(/^p(?:(\d+)w)?(?:(\d+)d)?$/i) || d.match(/^pt(\d+)h$/i) || d.match(/^p(\d+)d$/i);
    if (mISO) {
      if (mISO[1] && mISO[2]) return (+mISO[1])*7 + (+mISO[2]);
      if (/^pt/i.test(d)) return Math.max(0.04, (+mISO[1])/24);
      if (/^p(\d+)d$/i.test(d)) return +mISO[1];
    }
    const m = d.match(/(\d+)\s*(h|hora|horas|d|dia|dias|sem|semanas|m|mes|meses)/);
    if (m) {
      const n = +m[1];
      const u = m[2];
      if (/^h/.test(u)) return Math.max(0.04, n/24);
      if (/^d|dia/.test(u)) return n;
      if (/^sem/.test(u)) return n*7;
      if (/^m|mes/.test(u)) return n*30;
    }
    return null;
  }

  function detectConflict(payload) {
    const ft = norm(payload?.freeText || "");
    const semTosse = /\bsem\s+tosse\b/.test(ft) || /\bnega\s+tosse\b/.test(ft);
    const semFebre = /\bsem\s+febre\b/.test(ft) || /\bafebril\b/.test(ft) || /\bnega\s+febre\b/.test(ft);
    const sx = new Set((payload?.symptoms || []).map(norm));
    if (semTosse && sx.has("tosse")) return true;
    if (semFebre && sx.has("febre")) return true;
    return false;
  }

  function isLowTextImpact(local) {
    // pouco gap + confiança razoável + houve texto livre informado
    const noGaps = !local.gaps || ((local.gaps.questions || []).length === 0 && (local.gaps.unknownSx || []).length === 0);
    const hasText = !!(local.payload && typeof local.payload.freeText === "string" && local.payload.freeText.trim().length > 0);
    // se top1 mudou pouco entre execuções não temos histórico aqui;
    // heurística: confiança >= 0.60 sem gaps e com texto => pode valer segunda opinião do backend
    return noGaps && local.confidence >= 0.60 && hasText;
  }

  // ----------------- Rules cache -----------------
  const CACHE = { rules: null, rulesUrl: null, last: null };

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
      return {};
    }
  }

  // ----------------- Local engine wrapper -----------------
  function runLocal(payload, rules) {
    // garante domínio e duration_days para o motor local (se ele quiser usar)
    const enriched = { ...payload };
    if (!enriched.domain) enriched.domain = inferDomain(enriched);
    const dd = parseDurationDaysFrom(enriched);
    if (dd != null && !enriched.duration_days) enriched.duration_days = dd;

    // diagnostics.js expõe window.localDifferentials(payload, rules)
    if (typeof window.localDifferentials !== "function") {
      // fallback por priors (mantém compat)
      return localByPriors(enriched, rules);
    }
    const local = window.localDifferentials(enriched, rules) || { list: [], confidence: 0.5 };
    // normalize e anexar payload para decisões subsequentes
    local.top3 = (local.list || []).map(d => ({ dx: d.dx, norm: d.probability ?? d.norm ?? 0 }));
    local.payload = enriched;
    return local;
  }

  function localByPriors(payload, rules) {
    const domain = payload.domain || inferDomain(payload);
    const dxList = (rules?.domains?.[domain]?.dx) || [];
    const scored = [];
    for (const dx of dxList) {
      const prior = clamp(Number(dx?.prior ?? 0.1), 0.001, 0.95);
      scored.push({ dx: dx?.name || dx?.dx || "dx", norm: prior });
    }
    scored.sort((a, b) => b.norm - a.norm);
    const top3 = scored.slice(0, 3);
    const confidence = clamp(top3[0]?.norm ?? 0.5, 0, 1);
    return {
      list: top3.map(i => ({ dx: i.dx, probability: i.norm })),
      top3,
      confidence,
      payload
    };
  }

  // ----------------- Backend call -----------------
  async function callLLMBackendForTriage(payload) {
    const duration_days = parseDurationDaysFrom(payload);
    const body = {
      model_hint: CONFIG.MODEL_HINT,
      stream: CONFIG.STREAM,
      max_tokens: CONFIG.MAX_TOKENS,
      temperature: CONFIG.TEMPERATURE,

      // clínico
      free_text: payload.freeText || "",
      age: payload.age ?? null,
      sex: payload.sex ?? null,
      duration_days: duration_days ?? null,
      trajectory: payload.trajectory ?? payload?.extras?.parsed?.trajectory ?? null,
      fever_max_c: payload.fever_max_c ?? payload?.extras?.parsed?.feverMaxC ?? null,

      // contexto
      domain: payload.domain || inferDomain(payload),
      symptoms: payload.symptoms || [],
      comorbidities: payload.comorbidities || [],
      medications: payload.medications || [],
      red_flags_reported: payload.red_flags_reported || []
    };

    const url = (CONFIG.BACKEND_API_URL || "").replace(/\/+$/, "") + CONFIG.ENDPOINT;
    const req = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      const res = await withTimeout(req, CONFIG.TIMEOUT_MS, "backend-timeout");
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const json = await res.json();
      // contrato esperado: {differentials:[{dx, probability, rationale}], next_steps:[], care_level, red_flags:[], safety_note, references?:[]}
      // saneamento
      if (Array.isArray(json?.differentials)) {
        json.differentials = json.differentials.map(d => ({
          dx: d.dx,
          probability: d.probability ?? d.prob ?? 0,
          rationale: d.rationale || d.reason || null
        }));
      }
      return json;
    } catch (e) {
      console.warn("backend error:", e);
      return { _error: true, message: String(e) };
    }
  }

  // ----------------- Orchestrator -----------------
  async function run(payload, opts = {}) {
    const options = Object.assign({ rulesUrl: null, forceLLM: false }, opts);
    const rules = await loadRules(options.rulesUrl);

    // 1) Motor local
    const local = runLocal(payload || {}, rules);

    // 2) Critérios para acionar backend
    const conflict = detectConflict(local.payload);
    const lowImpact = isLowTextImpact(local);
    const needLLM =
      options.forceLLM ||
      (local.confidence < CONFIG.CONFIDENCE_THRESHOLD) ||
      (local.gaps?.unknownSx?.length > 0) ||
      (local.redFlags?.any) ||
      lowImpact ||
      conflict;

    // 3) Backend
    let backendResp = null;
    if (needLLM && CONFIG.BACKEND_API_URL?.startsWith("http")) {
      backendResp = await callLLMBackendForTriage(local.payload);
    }

    // 4) Resultado final
    const result = {
      ok: true,
      local,
      backend: backendResp,
      meta: {
        used_backend: !!backendResp,
        reasons: {
          low_confidence: local.confidence < CONFIG.CONFIDENCE_THRESHOLD,
          unknown_sx: (local.gaps?.unknownSx || []).length > 0,
          red_flags: !!local.redFlags?.any,
          low_text_impact: lowImpact,
          conflict
        }
      }
    };
    CACHE.last = result;
    return result;
  }

  function last() { return CACHE.last; }
  function setConfig(partial) { Object.assign(CONFIG, partial || {}); }

  // expose
  window.ROBOTTO = { run, loadRules, setConfig, last };
})();
// -----------------------------
// ROBOTTO v2.0+ (2025-08-19)