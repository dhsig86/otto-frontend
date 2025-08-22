/*
  ROBOTTO — Tele-ENT Triage Orchestrator
  File: robotto.js
  Version: 5.0.0 (2025-08-22)

  O que este orquestrador faz
  ---------------------------
  1) Motor local primeiro (diagnostics.js); enriquece payload (domínio, duração normalizada).
  2) Decide quando chamar o backend /api/triage (LLM JSON) de forma "balanced" e fluida:
     - Qualquer texto digitado (>=4 chars) em balanced libera LLM se confiança local < 0.95.
     - Conflitos/flags sempre liberam.
     - Sem “apenas demografia”.
  3) Injeta um "contexto local" no free_text para acelerar o raciocínio do LLM.
  4) Faz blend local+backend (peso configurável) e unifica perguntas sugeridas.
  5) EXPÕE também um modo de entrevista sequencial via /api/ask:
     - ROBOTTO.ask(caseState, lastUserText, goal?, style?) -> {assistant_text, quick_replies, used_fallback}
     - ROBOTTO.buildCaseState(payload) para montar o case compacto a partir do payload atual.
  6) Mantém API anterior:
     window.ROBOTTO = {
       run(payload, { rulesUrl?, forceLLM? } = {}) -> { ok, local, backend, meta },
       ask(caseState, lastUserText, goal?, style?) -> Promise<...>,
       buildCaseState(payload) -> caseState,
       loadRules(url), setConfig(partial), last()
     }

  NOTA: Este arquivo não renderiza UI; apenas orquestra. app-ui.js faz a apresentação.
*/

(function () {
  // ========================= Config =========================
  const CONFIG = {
    // Defina no index.html antes dos scripts:
    //   window.ROB_BACKEND_API_URL = "https://<SEU-HEROKU-APP>.herokuapp.com";
    BACKEND_API_URL: (window.ROB_BACKEND_API_URL || "https://<CONFIGURE-BACKEND>.example.com"),
    ENDPOINT_TRIAGE: "/api/triage",
    ENDPOINT_ASK: "/api/ask",

    // Orquestração
    CALL_LLM_POLICY: "balanced",   // "gpt_preferred" | "balanced" | "local_preferred"
    LOCAL_CONF_THRESHOLD: 0.72,    // quanto maior, mais chances de chamar LLM
    HYBRID_BACKEND_WEIGHT: 0.60,   // blend local x backend no top-3 final

    // Prompt/meta
    LANG: "pt-BR",
    DEEMPHASIZE_DURATION: true,

    // Timeout de rede (ms)
    TIMEOUT_MS: 18000,             // deve ser <= ao deadline do backend
    TIMEOUT_ASK_MS: 10000
  };

  // ================== System Prompt (PT-BR) ==================
  // Embutimos como "hint" no free_text para orientar o LLM de /api/triage.
  const SYSTEM_PROMPT_PT = `
Você é o OTTO, um assistente de triagem em Otorrinolaringologia. Fale SEMPRE em português do Brasil.

Objetivo: retornar até 3 diagnósticos diferenciais com breve justificativa; listar red flags; próximos passos; e, se necessário, sugerir 1–2 perguntas de cada vez (preferencialmente SIM/NÃO).
Prioridades: (1) Segurança; (2) Clareza; (3) Parcimônia — não deixe "tempo de sintomas" dominar o raciocínio.

Formato JSON de saída esperado:
{
  "differentials": [{"dx": "...", "probability": 0..1, "rationale": "..."}],
  "next_steps": ["..."],
  "care_level": "emergency"|"urgency"|"routine"|null,
  "red_flags": ["..."],
  "safety_note": "...",
  "references": ["..."],
  "query_suggestions": { "questions": [{ "text": "Pergunta SIM/NÃO", "options": ["Sim","Não"] }] }
}
Se vier apenas demografia, retorne uma pergunta única e objetiva para iniciar a coleta.
`.trim();

  // ================ Utils de base (puros) =================
  const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : a));
  const norm = (s) => (s || "").toLowerCase().trim();
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

  function withTimeout(promise, ms, label = "timeout") {
    let t;
    const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(label)), ms)));
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function parseDurationDaysFrom(payload) {
    if (payload?.extras?.parsed?.durationDays != null) return payload.extras.parsed.durationDays;
    const d = String(payload?.duration || payload?.duration_norm || "").toLowerCase();

    // ISO-like P#M#W#D
    let m = d.match(/^p(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?$/i);
    if (m) {
      const months = m[1] ? +m[1] : 0;
      const weeks  = m[2] ? +m[2] : 0;
      const days   = m[3] ? +m[3] : 0;
      return months * 30 + weeks * 7 + days;
    }
    // PT#h
    m = d.match(/^pt(\d+)h$/i);
    if (m) return Math.max(0.04, (+m[1]) / 24);

    // textos livres: "3 dias", "2 semanas", "1 mes", "48h"
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
    // fallback: usar payload.domain se existir, senão "garganta"
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

  // >>> Mudança de texto é SEMPRE significativa (removeu limite por caracteres)
  function significantChange(prev, curr) {
    if (!prev) return true;

    const keysToTrack = [
      "domain", "age", "sex", "trajectory", "fever_max_c", "duration", "duration_norm",
      "pain_bucket", "painScale"
    ];
    for (const k of keysToTrack) {
      if ((prev[k] ?? null) !== (curr[k] ?? null)) return true;
    }

    const tPrev = norm(prev.freeTextOriginal || prev.freeText || "");
    const tCurr = norm(curr.freeTextOriginal || curr.freeText || "");
    if (tPrev !== tCurr) return true;

    const a = new Set((prev.symptoms || []).map(norm));
    const b = new Set((curr.symptoms || []).map(norm));
    if (a.size !== b.size) return true;
    for (const x of b) if (!a.has(x)) return true;

    const fa = new Set((prev.red_flags_reported || []).map(norm));
    const fb = new Set((curr.red_flags_reported || []).map(norm));
    if (fa.size !== fb.size) return true;
    for (const x of fb) if (!fa.has(x)) return true;

    return false;
  }

  function isOnlyDemographics(payload) {
    const hasDemo = (payload?.age != null) || !!payload?.sex;
    const hasSymptoms = (payload?.symptoms || []).length > 0;
    const hasFlags = (payload?.red_flags_reported || []).length > 0;
    const hasClinSignals =
      !!(payload?.trajectory) ||
      (payload?.fever_max_c != null) ||
      !!(payload?.duration || payload?.duration_norm) ||
      (payload?.negations && payload.negations.length > 0);

    if (!hasDemo) return false;
    if (hasSymptoms || hasFlags || hasClinSignals) return false;

    const t = String(payload?.freeTextOriginal || payload?.freeText || "").toLowerCase();
    if (!t) return true;
    const stripped = t
      .replace(/\d+/g, "")
      .replace(/\b(anos?|masculin[oa]|feminin[oa]|homem|mulher|masc|fem|sexo|idade)\b/g, "")
      .trim();
    return stripped.length === 0;
  }

  // ================== Cache de regras e último run ==================
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

  // ====================== Motor local ======================
  function runLocal(payload, rules) {
    const enriched = { ...payload };
    if (!enriched.domain) enriched.domain = inferDomain(enriched);

    const dd = parseDurationDaysFrom(enriched);
    if (dd != null && !enriched.duration_days) enriched.duration_days = dd;

    if (typeof window.localDifferentials !== "function") {
      return { list: [], top3: [], confidence: 0.5, payload: enriched, gaps: { questions: [] }, red_flags: [] };
    }
    const local = window.localDifferentials(enriched, rules) || { list: [], confidence: 0.5, gaps: { questions: [] }, red_flags: [] };
    local.top3 = (local.list || []).map(d => ({ dx: d.dx, norm: d.probability ?? d.norm ?? 0 }));
    local.payload = enriched;
    return local;
  }

  // ============ Contexto local embedado no free_text ============
  function buildAugmentedFreeText(payload, local) {
    const userText = (payload.freeTextOriginal || payload.freeText || "").trim();

    const top3 = (local?.top3 || []).slice(0, 3)
      .map((d, i) => `${i+1}. ${d.dx} (~${Math.round((d.norm||0)*100)}%)`)
      .join("\n") || "- (sem hipóteses locais)";

    const gaps = (local?.gaps?.questions || [])
      .slice(0, 3)
      .map(q => `- ${q}`)
      .join("\n") || "- (sem perguntas locais)";

    const flags = (payload.red_flags_reported || [])
      .map(f => `- ${f}`).join("\n") || "- (nenhuma relatada)";

    const ctx =
`[system_prompt_hint]
${SYSTEM_PROMPT_PT}
[/system_prompt_hint]

[contexto_local]
domínio: ${payload.domain || inferDomain(payload)}
idioma: ${CONFIG.LANG}
idade: ${payload.age ?? "n/d"}, sexo: ${payload.sex ?? "n/d"}
duração(dias): ${parseDurationDaysFrom(payload) ?? "n/d"}
trajetória: ${payload.trajectory ?? "n/d"}
tmax: ${payload.fever_max_c ?? "n/d"}
sintomas: ${(payload.symptoms || []).join(", ") || "n/d"}
negações: ${(payload.negations || []).join(", ") || "n/d"}
flags_reportadas:
${flags}

estratégia:
- prefer_llm_reasoning=${CONFIG.CALL_LLM_POLICY !== "local_preferred"}
- de_emphasize_duration=${!!CONFIG.DEEMPHASIZE_DURATION}
- backend_weight=${CONFIG.HYBRID_BACKEND_WEIGHT}

top3_local:
${top3}

lacunas_sugeridas:
${gaps}
[/contexto_local]`;

    return userText ? `${userText}\n\n${ctx}` : ctx;
  }

  // =================== Chamada ao backend ===================
  async function callLLMBackendForTriage(payload, local) {
    const body = {
      free_text: buildAugmentedFreeText(payload, local),
      age: payload.age ?? null,
      sex: payload.sex ?? null,
      domain: payload.domain ?? null,
      duration: payload.duration ?? payload.duration_norm ?? null,
      duration_days: payload.duration_days ?? null,
      trajectory: payload.trajectory ?? null,
      fever_max_c: payload.fever_max_c ?? null,
      negations: payload.negations || [],
      symptoms: payload.symptoms || [],
      comorbidities: payload.comorbidities || [],
      medications: payload.medications || [],
      red_flags_reported: payload.red_flags_reported || [],
      language: CONFIG.LANG,
      expect_json: true,
      include_suggestions: true,
      strategy: {
        prefer_llm_reasoning: CONFIG.CALL_LLM_POLICY !== "local_preferred",
        de_emphasize_duration: !!CONFIG.DEEMPHASIZE_DURATION,
        backend_weight: CONFIG.HYBRID_BACKEND_WEIGHT
      }
    };

    const urlBase = (CONFIG.BACKEND_API_URL || "").replace(/\/+$/, "");
    const url = urlBase + CONFIG.ENDPOINT_TRIAGE;
    const validUrl = /^https?:\/\//.test(urlBase) && !/[<>{}]/.test(urlBase);
    if (!validUrl) return { _error: true, message: "backend-url-not-configured" };

    const req = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    try {
      const res = await withTimeout(req, CONFIG.TIMEOUT_MS, "backend-timeout");
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const usedFallback = res.headers.get("X-Used-Fallback") === "true";
      const json = await res.json();

      // Normalização de campos
      if (Array.isArray(json?.differentials)) {
        json.differentials = json.differentials.map(d => ({
          dx: d.dx,
          probability: d.probability ?? d.prob ?? 0,
          rationale: d.rationale || d.reason || null
        }));
      }
      if (json?.query_suggestions?.questions && !Array.isArray(json.query_suggestions.questions)) {
        json.query_suggestions.questions = [];
      }
      json._used_fallback = !!usedFallback;
      return json;
    } catch (e) {
      console.warn("backend error:", e);
      return { _error: true, message: String(e) };
    }
  }

  // =============== Decisão: quando chamar LLM ===============
  function shouldCallLLM(policy, local, payload) {
    if (isOnlyDemographics(payload)) return false;

    const conf = local?.confidence ?? 0.0;
    const conflict = detectConflict(payload);
    const flags = (payload?.red_flags_reported || []).length > 0;
    const hasSymptoms = (payload?.symptoms || []).length > 0;
    const hasText = !!(payload?.freeTextOriginal || payload?.freeText);

    const threshold =
      policy === "gpt_preferred"   ? CONFIG.LOCAL_CONF_THRESHOLD
    : policy === "balanced"        ? Math.max(0.70, CONFIG.LOCAL_CONF_THRESHOLD - 0.05)
                                   : Math.max(0.60, CONFIG.LOCAL_CONF_THRESHOLD - 0.12);

    if (conflict) return true;
    if (flags) return true;
    if (conf < threshold) return true;
    if (policy === "gpt_preferred" && (hasSymptoms || hasText)) return true;

    // >>> Regra de fluidez: usuário digitou algo (>=4 chars) em balanced → libera LLM se conf < 0.95
    if (policy === "balanced" && hasText && norm(payload.freeText || payload.freeTextOriginal).length >= 4 &&
        (local?.confidence ?? 0) < 0.95) {
      return true;
    }

    // Mudança relevante desde a última rodada?
    if (significantChange(CACHE.lastPayload, payload)) return true;

    return false;
  }

  // ============== Blend local + backend (Top-3) ==============
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

  // ========= Unificação de perguntas sugeridas (UI) =========
  function unifyQuestions(local, backend) {
    const qLocal = (local?.gaps?.questions || []).map(text => ({ text: String(text), options: ["Sim", "Não"] }));
    const qBackend = (backend?.query_suggestions?.questions || []).map(q => ({
      text: String(q.text || q),
      options: Array.isArray(q.options) && q.options.length ? q.options : ["Sim", "Não"]
    }));

    const seen = new Set();
    const out = [];
    for (const q of [...qLocal, ...qBackend]) {
      const key = norm(q.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ text: q.text, options: uniq(q.options) });
    }
    return out.slice(0, 3);
  }

  // =============== CaseState p/ entrevistador ===============
  function buildCaseState(payload) {
    // Monta o "case" compacto para /api/ask — NÃO enviar histórico longo.
    const domain = payload.domain || inferDomain(payload);
    const duration_days = payload.duration_days ?? parseDurationDaysFrom(payload) ?? null;

    const caseState = {
      age: payload.age ?? null,
      sex: payload.sex ?? null,
      domainHints: [domain],
      observations: {
        symptoms: uniq(payload.symptoms || []),
        duration_days,
        trajectory: payload.trajectory || null,
        fever_max_c: payload.fever_max_c ?? null,
        negations: uniq(payload.negations || [])
      },
      answeredQA: payload.answeredQA || [],  // a UI pode popular isso
      red_flags_reported: uniq(payload.red_flags_reported || [])
    };
    // Limpa nulls para reduzir tokens
    function prune(obj) {
      if (Array.isArray(obj)) return obj.filter(v => v != null).map(prune);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v == null) continue;
          out[k] = prune(v);
        }
        return out;
      }
      return obj;
    }
    return prune(caseState);
  }

  // =============== Chamada ao entrevistador =================
  async function callAskEndpoint(caseState, lastUserText, goal, style) {
    const urlBase = (CONFIG.BACKEND_API_URL || "").replace(/\/+$/, "");
    const url = urlBase + CONFIG.ENDPOINT_ASK;
    const validUrl = /^https?:\/\//.test(urlBase) && !/[<>{}]/.test(urlBase);
    if (!validUrl) return { _error: true, message: "backend-url-not-configured" };

    const body = {
      case: caseState || {},
      last_user_text: String(lastUserText || ""),
      language: CONFIG.LANG,
      style: style || "breve",
      goal: goal || "next_question"
    };

    const req = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    try {
      const res = await withTimeout(req, CONFIG.TIMEOUT_ASK_MS, "ask-timeout");
      if (!res.ok) throw new Error(`backend ${res.status}`);
      const usedFallback = res.headers.get("X-Used-Fallback") === "true";
      const json = await res.json();
      return { ...json, _used_fallback: !!usedFallback };
    } catch (e) {
      console.warn("ask error:", e);
      // fallback mínimo para UI não travar
      return {
        assistant_text: "Você percebe algum sinal de alarme como dificuldade para respirar, engolir ou sangramento?",
        quick_replies: ["Sim", "Não"],
        _used_fallback: true,
        _error: true,
        message: String(e)
      };
    }
  }

  // ====================== Orchestrator ======================
  async function run(payload, opts = {}) {
    const options = Object.assign({ rulesUrl: null, forceLLM: false }, opts);
    const rules = await loadRules(options.rulesUrl);

    // 0) Inferir domínio se ausente
    if (!payload?.domain) payload = { ...payload, domain: inferDomain(payload || {}) };

    // 1) Motor local
    const local = runLocal(payload || {}, rules);

    // 2) Gate: apenas demografia? devolve “deferir” e DICA: comece entrevista
    const onlyDemo = isOnlyDemographics(local.payload);
    if (onlyDemo) {
      const caseState = buildCaseState(local.payload);
      const deferOut = {
        ok: true,
        local: Object.assign({}, local, { blendedTop3: [] }),
        backend: null,
        meta: {
          ready: false,
          deferred_reason: "only_demographics",
          policy: CONFIG.CALL_LLM_POLICY,
          used_backend: false,
          reasons: {
            below_threshold: null,
            flags_present: false,
            conflict: false,
            significant_change: significantChange(CACHE.lastPayload, local.payload),
            only_demographics_blocked: true
          },
          // A UI pode, se quiser, acionar o entrevistador com este caseState:
          ask_hint: {
            caseState,
            goal: "next_question",
            quickStart: true
          },
          suggested_questions: unifyQuestions(local, null)
        }
      };
      CACHE.last = deferOut;
      CACHE.lastPayload = JSON.parse(JSON.stringify(local.payload || {}));
      return deferOut;
    }

    // 3) Decisão de chamada do backend
    const policy = CONFIG.CALL_LLM_POLICY;
    const callLLM = options.forceLLM || shouldCallLLM(policy, local, local.payload);

    // 4) Backend /api/triage
    let backendResp = null;
    if (callLLM) {
      backendResp = await callLLMBackendForTriage(local.payload, local);
    }

    // 5) Blend
    let finalTop3 = (local.top3 || []).map(d => ({ dx: d.dx, probability: d.norm }));
    if (backendResp && !backendResp._error && Array.isArray(backendResp.differentials)) {
      finalTop3 = blendDifferentials(finalTop3, backendResp.differentials, CONFIG.HYBRID_BACKEND_WEIGHT);
    }

    // 6) Red flags unificadas
    const rfLocal = local.red_flags || [];
    const rfBack = (backendResp && backendResp.red_flags) || [];
    const redFlagsMerged = uniq([...rfLocal, ...rfBack]);

    // 7) Perguntas unificadas
    const questions = unifyQuestions(local, backendResp);

    // 8) Resultado final
    const result = {
      ok: true,
      local: Object.assign({}, local, { blendedTop3: finalTop3 }),
      backend: backendResp,
      meta: {
        ready: true,
        policy,
        used_backend: !!backendResp && !backendResp._error,
        backend_used_fallback: !!(backendResp && backendResp._used_fallback),
        red_flags_merged: redFlagsMerged,
        suggested_questions: questions,
        reasons: {
          below_threshold: (local.confidence ?? 0) < CONFIG.LOCAL_CONF_THRESHOLD,
          flags_present: (local.payload?.red_flags_reported || []).length > 0,
          conflict: detectConflict(local.payload),
          significant_change: significantChange(CACHE.lastPayload, local.payload),
          only_demographics_blocked: false
        },
        // Para a fase SEQUENTIAL_QA, a UI pode usar:
        ask_hint: {
          caseState: buildCaseState(local.payload),
          goal: questions.length ? "next_question" : "confirm_summary",
          quickStart: false
        }
      }
    };

    CACHE.last = result;
    CACHE.lastPayload = JSON.parse(JSON.stringify(local.payload || {}));
    return result;
  }

  // ===================== Exposed helpers =====================
  async function ask(caseState, lastUserText, goal = "next_question", style = "breve") {
    return await callAskEndpoint(caseState || {}, lastUserText || "", goal, style);
  }

  function last() { return CACHE.last; }

  function setConfig(partial) {
    if (!partial || typeof partial !== "object") return;
    Object.assign(CONFIG, partial);
    CONFIG.HYBRID_BACKEND_WEIGHT = clamp(CONFIG.HYBRID_BACKEND_WEIGHT, 0, 1);
    CONFIG.LOCAL_CONF_THRESHOLD = clamp(CONFIG.LOCAL_CONF_THRESHOLD, 0.5, 0.98);
    if (partial.LANG) CONFIG.LANG = String(partial.LANG);
  }

  // ======================= Public API ========================
  window.ROBOTTO = { run, ask, buildCaseState, loadRules, setConfig, last };
})();
