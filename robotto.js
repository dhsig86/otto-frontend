/*
  ROBOTTO — Tele-ENT Triage Orchestrator
  File: robotto.js
  Version: 3.0.0 (2025-08-20)

  Objetivo desta revisão:
  - Dar mais protagonismo ao backend (GPT-5-nano) no raciocínio clínico e na seleção de sintomas/red flags.
  - Manter idade/sexo/duração/febre como sinais contextuais, mas sem sobreponderá-los.
  - Chamar o backend com mais frequência em mudanças de contexto do usuário (texto/sintomas/flags).
  - Continuar compatível com diagnostics.js v4 e app-ui.js v3.

  API exposta:
    window.ROBOTTO = {
      run(payload, { rulesUrl?, forceLLM? } = {}) -> { ok, local, backend, meta },
      setConfig(partial),     // alterar thresholds e URL do backend
      loadRules(url),         // pré-carrega rules json
      last()                  // último resultado
    }
*/

(function () {
  // ----------------- Config -----------------
  const CONFIG = {
    BACKEND_API_URL: (window.ROB_BACKEND_API_URL || "https://<your-backend>.example.com"),
    ENDPOINT: "/api/triage",
    MODEL_HINT: "gpt-5-nano",
    TIMEOUT_MS: 120000,
    STREAM: false,
    MAX_TOKENS: 900,
    TEMPERATURE: 1,

    // Política de orquestração: "gpt_preferred" | "balanced" | "local_preferred"
    CALL_LLM_POLICY: "gpt_preferred",

    // Threshold de confiança do motor local para acionar LLM (quanto MAIOR, mais chamadas ao LLM)
    LOCAL_CONF_THRESHOLD: 0.78, // gpt_preferred sugere >= 0.78

    // Peso do blend quando os dois estão disponíveis (0..1) — peso do BACKEND
    HYBRID_BACKEND_WEIGHT: 0.70,

    // Deixar claro ao backend que duração não deve dominar o raciocínio
    DEEMPHASIZE_DURATION: true
  };

  // ----------------- Utils -----------------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : a));
  const norm = (s) => (s || "").toLowerCase().trim();

  function withTimeout(promise, ms, label = "timeout") {
    let t;
    const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(label)), ms)));
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function parseDurationDaysFrom(payload) {
    // Preferir parser do diagnostics/app-ui, se existir
    if (payload?.extras?.parsed?.durationDays != null) return payload.extras.parsed.durationDays;

    const d = String(payload?.duration || payload?.duration_norm || "").toLowerCase();

    // ISO simplificado: P{M}M P{W}W P{D}D (qualquer combinação) e PT{H}H
    let m = d.match(/^p(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?$/i);
    if (m) {
      const months = m[1] ? +m[1] : 0;
      const weeks  = m[2] ? +m[2] : 0;
      const days   = m[3] ? +m[3] : 0;
      return months * 30 + weeks * 7 + days;
    }
    m = d.match(/^pt(\d+)h$/i);
    if (m) return Math.max(0.04, (+m[1]) / 24);

    // Fallback: linguagem natural
    const m2 = d.match(/(\d+)\s*(h|hora|horas|d|dia|dias|sem|semanas|m|mes|meses)/);
    if (m2) {
      const n = +m2[1];
      const u = m2[2];
      if (/^h/.test(u)) return Math.max(0.04, n / 24);
      if (/^d|dia/.test(u)) return n;
      if (/^sem/.test(u)) return n * 7;
      if (/^m|mes/.test(u)) return n * 30;
    }
    return null;
  }

  function inferDomain(payload) {
    const t = norm(payload?.freeText || payload?.freeTextOriginal || "");
    if (/ouvid|otalg|otit|timp|orelha/.test(t)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus|epistax/.test(t)) return "nariz";
    if (/gargant|faring|larin|amigdal|odinofag/.test(t)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(t)) return "pescoco";
    return payload?.domain || "garganta";
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

  // Detecta se houve mudança de contexto que justifica reconsultar o backend
  // (privilegiando raciocínio do LLM nas interações).
  function significantChange(prev, curr) {
    if (!prev) return true;
    const keysToTrack = [
      "domain", "age", "sex", "trajectory", "fever_max_c", "duration", "duration_norm",
      "pain_bucket", "painScale"
    ];
    for (const k of keysToTrack) {
      if ((prev[k] ?? null) !== (curr[k] ?? null)) return true;
    }
    // Texto livre: diferença > 12 caracteres
    const tPrev = norm(prev.freeTextOriginal || prev.freeText || "");
    const tCurr = norm(curr.freeTextOriginal || curr.freeText || "");
    if (Math.abs(tCurr.length - tPrev.length) > 12) return true;

    // Sintomas: conjunto mudou?
    const a = new Set((prev.symptoms || []).map(norm));
    const b = new Set((curr.symptoms || []).map(norm));
    if (a.size !== b.size) return true;
    for (const x of b) if (!a.has(x)) return true;

    // Flags
    const fa = new Set((prev.red_flags_reported || []).map(norm));
    const fb = new Set((curr.red_flags_reported || []).map(norm));
    if (fa.size !== fb.size) return true;
    for (const x of fb) if (!fa.has(x)) return true;

    return false;
  }

  // ----------------- Rules cache -----------------
  const CACHE = { rules: null, rulesUrl: null, last: null, lastPayload: null };

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
    const enriched = { ...payload };
    if (!enriched.domain) enriched.domain = inferDomain(enriched);

    // duração em dias — útil para diagnostics.js, mas não será sobreponderado na orquestração
    const dd = parseDurationDaysFrom(enriched);
    if (dd != null && !enriched.duration_days) enriched.duration_days = dd;

    if (typeof window.localDifferentials !== "function") {
      return { list: [], top3: [], confidence: 0.5, payload: enriched };
    }
    const local = window.localDifferentials(enriched, rules) || { list: [], confidence: 0.5 };
    local.top3 = (local.list || []).map(d => ({ dx: d.dx, norm: d.probability ?? d.norm ?? 0 }));
    local.payload = enriched;
    return local;
  }

  // ----------------- Backend call -----------------
  async function callLLMBackendForTriage(payload) {
    const duration_days = parseDurationDaysFrom(payload);

    const strategy = {
      prefer_llm_reasoning: CONFIG.CALL_LLM_POLICY !== "local_preferred",
      de_emphasize_duration: !!CONFIG.DEEMPHASIZE_DURATION,
      backend_weight: CONFIG.HYBRID_BACKEND_WEIGHT
    };

    const body = {
      model_hint: CONFIG.MODEL_HINT,
      stream: CONFIG.STREAM,
      max_tokens: CONFIG.MAX_TOKENS,
      temperature: CONFIG.TEMPERATURE,

      // clínico
      free_text: payload.freeText || "",
      age: payload.age ?? null,
      sex: payload.sex ?? null,
      duration_days: duration_days ?? null,  // incluímos, mas backend é instruído a não sobreponderar
      trajectory: payload.trajectory ?? payload?.extras?.parsed?.trajectory ?? null,
      fever_max_c: payload.fever_max_c ?? payload?.extras?.parsed?.feverMaxC ?? null,
      negations: payload.negations || payload?.extras?.parsed?.negations || [],
      pain: { bucket: payload.pain_bucket ?? payload?.extras?.parsed?.pain?.label ?? null,
              nrs:    payload.painScale  ?? payload?.extras?.parsed?.pain?.nrs   ?? null },

      // contexto
      domain: payload.domain || inferDomain(payload),
      symptoms: payload.symptoms || [],
      comorbidities: payload.comorbidities || [],
      medications: payload.medications || [],
      red_flags_reported: payload.red_flags_reported || [],

      // orientação de orquestração
      strategy
    };

    const url = (CONFIG.BACKEND_API_URL || "").replace(/\/+$/, "") + CONFIG.ENDPOINT;
    const validUrl = /^https?:\/\//.test(CONFIG.BACKEND_API_URL || "") && !/[<>{}]/.test(CONFIG.BACKEND_API_URL);
    if (!validUrl) return { _error: true, message: "backend-url-not-configured" };

    const req = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    try {
      const res = await withTimeout(req, CONFIG.TIMEOUT_MS, "backend-timeout");
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const json = await res.json();
      // contrato esperado: {differentials:[{dx, probability, rationale}], next_steps:[], care_level, red_flags:[], safety_note, references?:[], query_suggestions?:{symptoms?:[], flags?:[]}}
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
  function shouldCallLLM(policy, local, payload) {
    const conf = local?.confidence ?? 0.0;
    const conflict = detectConflict(payload);
    const flags = (payload?.red_flags_reported || []).length > 0;
    const hasSymptoms = (payload?.symptoms || []).length > 0;
    const hasText = !!(payload?.freeTextOriginal || payload?.freeText);

    const threshold =
      policy === "gpt_preferred"   ? CONFIG.LOCAL_CONF_THRESHOLD
    : policy === "balanced"        ? Math.max(0.70, CONFIG.LOCAL_CONF_THRESHOLD - 0.05)
                                   : Math.max(0.60, CONFIG.LOCAL_CONF_THRESHOLD - 0.12);

    // Critérios: privilegiar backend nas interações
    if (conflict) return true;                 // texto vs checklist conflitantes
    if (flags) return true;                    // qualquer red flag sinalizada
    if (conf < threshold) return true;         // confiança local aquém do patamar
    if (policy === "gpt_preferred" && (hasSymptoms || hasText)) return true; // dialogar mais com o LLM

    // Caso contrário, só chama se o usuário de fato mudou algo relevante desde a última execução
    if (significantChange(CACHE.lastPayload, payload)) return true;

    return false;
  }

  function blendDifferentials(localList, backendList, wBackend) {
    const map = new Map();
    (localList || []).forEach(d => {
      const p = d.probability ?? d.norm ?? 0;
      map.set(d.dx, { local: p, backend: 0 });
    });
    (backendList || []).forEach(d => {
      const p = d.probability ?? d.prob ?? 0;
      const prev = map.get(d.dx) || { local: 0, backend: 0 };
      prev.backend = Math.max(prev.backend, p);
      map.set(d.dx, prev);
    });

    const blended = [];
    for (const [dx, v] of map.entries()) {
      const p = clamp(wBackend * v.backend + (1 - wBackend) * v.local, 0, 1);
      blended.push({ dx, probability: p });
    }
    blended.sort((a, b) => b.probability - a.probability);
    return blended.slice(0, 3);
  }

  async function run(payload, opts = {}) {
    const options = Object.assign({ rulesUrl: null, forceLLM: false }, opts);
    const rules = await loadRules(options.rulesUrl);

    // 1) Motor local (rápido; não sobrepesa duração)
    const local = runLocal(payload || {}, rules);

    // 2) Decisão de chamada do backend — mais agressiva em gpt_preferred
    const policy = CONFIG.CALL_LLM_POLICY;
    const callLLM = options.forceLLM || shouldCallLLM(policy, local, local.payload);

    // 3) Backend
    let backendResp = null;
    if (callLLM) {
      backendResp = await callLLMBackendForTriage(local.payload);
    }

    // 4) Blend opcional (mantém compat com app-ui: continuamos retornando local/backend separados)
    let finalTop3 = local.top3?.map(d => ({ dx: d.dx, probability: d.norm })) || [];
    if (backendResp && !backendResp._error && Array.isArray(backendResp.differentials)) {
      finalTop3 = blendDifferentials(
        finalTop3,
        backendResp.differentials,
        CONFIG.HYBRID_BACKEND_WEIGHT
      );
    }

    // 5) Resultado
    const result = {
      ok: true,
      local: Object.assign({}, local, { blendedTop3: finalTop3 }),
      backend: backendResp,
      meta: {
        policy,
        used_backend: !!backendResp && !backendResp._error,
        reasons: {
          below_threshold: (local.confidence ?? 0) < CONFIG.LOCAL_CONF_THRESHOLD,
          flags_present: (local.payload?.red_flags_reported || []).length > 0,
          conflict: detectConflict(local.payload),
          significant_change: significantChange(CACHE.lastPayload, local.payload)
        }
      }
    };

    CACHE.last = result;
    CACHE.lastPayload = JSON.parse(JSON.stringify(local.payload || {}));
    return result;
  }

  function last() { return CACHE.last; }
  function setConfig(partial) {
    if (!partial || typeof partial !== "object") return;
    Object.assign(CONFIG, partial);
    // sanity: clamp ranges
    CONFIG.HYBRID_BACKEND_WEIGHT = clamp(CONFIG.HYBRID_BACKEND_WEIGHT, 0, 1);
    CONFIG.LOCAL_CONF_THRESHOLD = clamp(CONFIG.LOCAL_CONF_THRESHOLD, 0.5, 0.95);
  }

  // expose
  window.ROBOTTO = { run, loadRules, setConfig, last };
})();
