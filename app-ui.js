// app-ui.js (v4 — fluxo fluido: sintomas → flags uma vez, perguntas Sim/Não)
// Coordena a UI e orquestra o fluxo com ROBOTTO.run() e diagnostics.js v4.

(function () {
  // --------------------------
  // Estado global
  // --------------------------
  const state = {
    consented: false,
    flagsAnswered: false,          // flags respondidas pelo usuário
    _flagsOpenedOnce: false,       // garante que overlay de flags abre no máx. 1 vez
    askedSymptomsOnce: false,      // se já abrimos o checklist de sintomas
    lastRenderSig: null,           // evita render duplicado
    lastAskedQuestion: null,       // evita repetir a mesma pergunta Sim/Não
    payload: {
      domain: null,
      age: null,
      sex: null,                   // "M" | "F" | "OUTRO"
      duration: null,              // ISO: "P5D", "P2W", "P3M", "PT12H"
      duration_norm: null,         // compat
      trajectory: null,            // "piorando" | "melhorando" | "estavel" | "dupla_piora"
      fever_max_c: null,           // número, ex.: 38.5
      pain_bucket: null,           // "leve" | "moderada" | "intensa"
      painScale: null,             // 0..10
      negations: [],
      symptoms: [],
      freeText: "",                // texto limpo (com negações tratadas)
      freeTextOriginal: "",        // texto bruto acumulado do usuário (histórico)
      comorbidities: [],
      medications: [],
      red_flags_reported: []
    },
    rulesUrl: "./rules_otorrino.json"
  };

  // Opcional: reforçar política (também está no index.html; manter aqui é inofensivo)
  if (window.ROBOTTO?.setConfig) {
    window.ROBOTTO.setConfig({
      CALL_LLM_POLICY: "balanced",
      LOCAL_CONF_THRESHOLD: 0.72,
      HYBRID_BACKEND_WEIGHT: 0.6
    });
  }

  // --------------------------
  // Catálogos (UI)
  // --------------------------
  const SYMPTOMS_UI = [
    { key: "febre", label: "Febre" },
    { key: "tosse", label: "Tosse" },
    { key: "dor_de_cabeca", label: "Dor de cabeça" },
    { key: "nariz_entupido", label: "Nariz entupido" },
    { key: "coriza", label: "Coriza ou Catarro" },
    { key: "mau_cheiro", label: "Mau cheiro" },
    { key: "reducao_olfato", label: "Redução do olfato" },
    { key: "reducao_paladar", label: "Redução do paladar" },
    { key: "pressao_na_face", label: "Pressão na face" },
    { key: "dor_de_ouvido", label: "Dor de ouvido" },
    { key: "sensacao_ouvido_tapado", label: "Sensação de ouvido tapado" },
    { key: "coceira_no_ouvido", label: "Coceira no ouvido" },
    { key: "dificuldade_de_ouvir", label: "Dificuldade de ouvir" },
    { key: "zumbido", label: "Zumbido" },
    { key: "tontura", label: "Tontura" },
    { key: "sensacao_de_desmaio", label: "Sensação de desmaio" },
    { key: "dor_de_garganta", label: "Dor de garganta" },
    { key: "mau_halito", label: "Mau hálito" },
    { key: "bolo_na_garganta", label: "Sensação de bolo na garganta" },
    { key: "disfagia", label: "Dificuldade para engolir" },
    { key: "linfonodos_cervicais", label: "Aumento dos gânglios do pescoço" },
    { key: "roncos", label: "Roncos" },
    { key: "secrecao_otica", label: "Secreção no ouvido" }
  ];

  const FLAGS_UI = [
    { key: "falta_de_ar", label: "Falta de ar / dificuldade para respirar" },
    { key: "dor_muito_intensa", label: "Dor muito intensa / insuportável" },
    { key: "sangramento_volumoso", label: "Sangramento volumoso" },
    { key: "rigidez_de_pescoco", label: "Rigidez de pescoço" },
    { key: "turvacao_visual", label: "Turvação visual súbita" },
    { key: "palpitacao", label: "Palpitação" },
    { key: "sensacao_de_desmaio", label: "Sensação de desmaio" }
  ];

  // --------------------------
  // Utilidades / DOM helpers
  // --------------------------
  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $("#messages");
  const quickEl = $("#quick-replies");
  const inputEl = $("#user-input");

  function addMessage(role, html) {
    const wrap = document.createElement("div");
    const base = "max-w-[85%] rounded px-3 py-2 text-sm shadow";
    if (role === "user") {
      wrap.className = "flex justify-end";
      wrap.innerHTML = `<div class="${base} bg-blue-600 text-white">${html}</div>`;
    } else {
      wrap.className = "flex items-start gap-2";
      wrap.innerHTML = `
        <img src="assets/otto-rounded.png" alt="OTTO" class="mt-1 h-7 w-7 rounded-full ring-1 ring-sky-200 dark:ring-gray-700"/>
        <div class="${base} bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">${html}</div>
      `;
    }
    messagesEl.appendChild(wrap);
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }

  let typingNode = null;
  function showTyping() {
    hideTyping();
    typingNode = document.createElement("div");
    typingNode.className = "flex justify-start";
    typingNode.innerHTML = `
      <div class="max-w-[85%] rounded px-3 py-2 text-sm shadow bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">
        <span class="inline-flex items-center gap-2">
          <span>OTTO está analisando</span>
          <span class="inline-flex gap-1">
            <span style="animation: blink 1.2s infinite">.</span>
            <span style="animation: blink 1.2s 0.2s infinite">.</span>
            <span style="animation: blink 1.2s 0.4s infinite">.</span>
          </span>
        </span>
      </div>`;
    messagesEl.appendChild(typingNode);
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }
  function hideTyping() {
    if (typingNode && typingNode.parentNode) typingNode.parentNode.removeChild(typingNode);
    typingNode = null;
  }

  // Quick replies padrão + handler custom
  function setQuickReplies(items = [], onClick) {
    quickEl.innerHTML = "";
    const suggestions = items.length ? items : [
      "Começaram há __ dias e desde então [pioraram/melhoraram/estão iguais].",
      "Desde o início, os sintomas estão [piorando/melhorando/iguais].",
      "Teve febre? Máxima de __ °C.",
      "Dor [leve/moderada/intensa] ou __/10."
    ];
    quickEl.className = "mb-2 flex gap-2 overflow-x-auto whitespace-nowrap";
    suggestions.slice(0, 5).forEach(txt => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "shrink-0 rounded-full border border-sky-200/60 bg-white px-3 py-1 text-xs text-sky-700 hover:bg-sky-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100";
      b.textContent = txt.replace(/^[•\-\d.\s]*/, "");
      b.addEventListener("click", () => {
        if (typeof onClick === "function") {
          onClick(b.textContent);
        } else {
          inputEl.value = (inputEl.value ? (inputEl.value.trim() + " ") : "") + b.textContent;
          inputEl.focus();
        }
      });
      quickEl.appendChild(b);
    });
    quickEl.style.display = "flex";
  }
  function hideQuickReplies() {
    quickEl.innerHTML = "";
    quickEl.style.display = "none";
  }

  function openOverlay(id) { const el = document.getElementById(id); if (el){ el.classList.remove("hidden"); el.classList.add("flex"); } }
  function closeOverlay(id) { const el = document.getElementById(id); if (el){ el.classList.add("hidden"); el.classList.remove("flex"); } }

  function renderSymptoms() {
    const box = $("#symptom-options");
    if (!box) return;
    box.innerHTML = "";
    SYMPTOMS_UI.forEach(s => {
      const checked = state.payload.symptoms.includes(s.key) ? "checked" : "";
      box.insertAdjacentHTML("beforeend", `
        <label class="flex items-center gap-2">
          <input type="checkbox" value="${s.key}" ${checked}/>
          <span>${s.label}</span>
        </label>
      `);
    });
  }

  function renderFlags() {
    const box = $("#flag-options");
    if (!box) return;
    box.innerHTML = "";
    FLAGS_UI.forEach(f => {
      const checked = state.payload.red_flags_reported.includes(f.key) ? "checked" : "";
      box.insertAdjacentHTML("beforeend", `
        <label class="flex items-center gap-2">
          <input type="checkbox" value="${f.key}" ${checked}/>
          <span>${f.label}</span>
        </label>
      `);
    });
    const noFlags = $("#no-flags");
    if (noFlags) noFlags.checked = state.payload.red_flags_reported.length === 0;
  }

  // --------------------------
  // Parser clínico (texto livre)
  // --------------------------
  const norm = (s) => (s || "").toLowerCase();

  function parseDemographicsFromText(t) {
    const res = {};
    // "39 anos" | "39" seguido de , masculino/feminino
    const mAge = t.match(/\b(\d{1,3})\s*anos?\b/) || t.match(/\b(\d{1,3})\b\s*(?:,|\s)\s*(?:masculin[oa]|feminin[oa]|homem|mulher|masc|fem)\b/i);
    if (mAge) {
      const age = parseInt(mAge[1], 10);
      if (!Number.isNaN(age) && age >= 0 && age <= 120) res.age = age;
    }
    if (/\b(feminina|feminino|mulher|fem)\b/i.test(t)) res.sex = "F";
    else if (/\b(masculina|masculino|homem|masc)\b/i.test(t)) res.sex = "M";
    return res;
  }

  function normalizeDurationToISO(qty, unit) {
    const n = Math.max(0, Number(qty || 0));
    const u = String(unit || "").toLowerCase();
    if (/(hora|h)/.test(u)) return `PT${n}H`;
    if (/(semana|sem)/.test(u)) return `P${n}W`;
    if (/(m[eê]s|mes)/.test(u)) return `P${n}M`;
    return `P${n}D`;
  }

  function extractDuration(t) {
    let raw = null, normISO = null;
    let m =
      t.match(/\b(há|faz|tem)\s*(\d{1,3})\s*(horas?|h|dias?|d|semanas?|sem|m[eê]s(?:es)?)\b/i) ||
      t.match(/\b(\d{1,3})\s*(horas?|h|dias?|d|semanas?|sem|m[eê]s(?:es)?)\b/i) ||
      t.match(/\b(\d{1,2})\s*[\/\-]?\s*d(?:ias?)?\b/i) ||
      t.match(/\b(\d{1,2})\s*[\/\-]?\s*sem(?:anas?)?\b/i) ||
      t.match(/\b(\d{1,2})\s*[\/\-]?\s*h(?:oras?)?\b/i);
    if (m) {
      if (m.length === 4) { raw = `${m[2]} ${m[3]}`; normISO = normalizeDurationToISO(m[2], m[3]); }
      else if (m.length >= 3) { raw = `${m[1]} ${m[2]}`; normISO = normalizeDurationToISO(m[1], m[2]); }
    } else {
      if (/desde\s+ontem/i.test(t)) { raw = "1 dia"; normISO = "P1D"; }
      else if (/desde\s+hoje/i.test(t)) { raw = "0 dia"; normISO = "P0D"; }
    }
    return { raw, normISO };
  }

  function extractTrajectory(t) {
    if (/\bdupla\s+piora\b/i.test(t)) return "dupla_piora";
    if (/\bpior(a|ou|ando)\b/i.test(t) || /\bpiorando\b/i.test(t)) return "piorando";
    if (/\bmelhor(a|ou|ando)\b/i.test(t) || /\bmelhorando\b/i.test(t)) return "melhorando";
    if (/\b(igual|est[aá]vel|na mesma|sem mudan[çc]a)\b/i.test(t)) return "estavel";
    return null;
  }

  function extractFeverMaxC(t) {
    const candidates = [];
    t.replace(/(\d{2}(?:[.,]\d)?)\s*(?:°|º)?\s*C\b/gi, (_, num) => { candidates.push(num); return _; });
    t.replace(/\b(?:febre|t\s*max|tmax|temperatura)\s*(\d{2}(?:[.,]\d)?)\b/gi, (_, num) => { candidates.push(num); return _; });
    if (/\bfebre|t\s*max|tmax|temperatura\b/i.test(t)) {
      t.replace(/\b(\d{2}(?:[.,]\d)?)\b/g, (_, num) => { candidates.push(num); return _; });
    }
    for (const raw of candidates) {
      const v = parseFloat(String(raw).replace(",", "."));
      if (!Number.isNaN(v) && v >= 35 && v <= 43) return v;
    }
    return null;
  }

  function extractPain(t) {
    if (/\bdor\s+(?:muito\s+)?(forte|intensa|severa)\b/i.test(t)) return { bucket: "intensa", nrs: 8 };
    if (/\bdor\s+moderad[ao]\b/i.test(t)) return { bucket: "moderada", nrs: 6 };
    if (/\bdor\s+leve\b/i.test(t)) return { bucket: "leve", nrs: 3 };
    const m = t.match(/\b(\d{1,2})\s*\/\s*10\b/);
    if (m) {
      const n = Math.max(0, Math.min(10, parseInt(m[1], 10)));
      let bucket = n >= 8 ? "intensa" : n >= 4 ? "moderada" : (n > 0 ? "leve" : "leve");
      return { bucket, nrs: n };
    }
    return { bucket: null, nrs: null };
  }

  function extractNegationsAndClean(text) {
    const neg = [];
    let t = " " + text + " ";
    const NEG_MAP = [
      { re: /(sem|nega|n[aã]o\s*tem)\s+febre\b/gi, token: "febre", replace: " afebril " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+tosse\b/gi, token: "tosse", replace: " sem_tosse " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+secre[cç][aã]o\b/gi, token: "secrecao", replace: " sem_secrecao " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+coriza\b/gi, token: "coriza", replace: " sem_coriza " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+dor\s+de\s+garganta\b/gi, token: "dor_garganta", replace: " sem_dor_garganta " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+dor\s+no?\s+ouvido\b/gi, token: "dor_ouvido", replace: " sem_dor_ouvido " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+zumbido\b/gi, token: "zumbido", replace: " sem_zumbido " },
      { re: /(sem|nega|n[aã]o\s*tem)\s+tontura\b/gi, token: "tontura", replace: " sem_tontura " },
    ];
    NEG_MAP.forEach(({ re, token, replace }) => {
      if (re.test(t)) neg.push(token);
      t = t.replace(re, replace);
    });
    t = t.replace(/\s{2,}/g, " ").trim();
    return { neg, cleaned: t };
  }

  function inferDomainFromText(t) {
    const s = t.toLowerCase();
    if (/ouvid|otalg|otite|timp|orelha/.test(s)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus|epistax/.test(s)) return "nariz";
    if (/gargant|faring|larin|amigdal|odinofag/.test(s)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(s)) return "pescoco";
    return null;
  }

  function parseClinicalText(aggregateOriginal) {
    const original = aggregateOriginal || "";
    const demo = parseDemographicsFromText(original);
    const negClean = extractNegationsAndClean(original);
    const t = negClean.cleaned;
    const dur = extractDuration(t);
    const traj = extractTrajectory(t);
    const tmax = extractFeverMaxC(t);
    const pain = extractPain(t);
    const dom = inferDomainFromText(t);

    return {
      demographics: demo,
      negations: negClean.neg,
      cleanedText: t,
      durationRaw: dur.raw,
      durationNorm: dur.normISO,
      trajectory: traj,
      feverMaxC: tmax,
      painBucket: pain.bucket,
      painNRS: pain.nrs,
      domainHint: dom
    };
  }

  function applyParsedToState(parsed) {
    if (!parsed) return;

    if (parsed.demographics?.age != null) state.payload.age = parsed.demographics.age;
    if (parsed.demographics?.sex) state.payload.sex = parsed.demographics.sex;

    if (parsed.durationNorm) {
      state.payload.duration = parsed.durationNorm;
      state.payload.duration_norm = parsed.durationNorm;
    }
    if (parsed.trajectory) state.payload.trajectory = parsed.trajectory;
    if (parsed.feverMaxC != null) state.payload.fever_max_c = parsed.feverMaxC;
    if (parsed.painBucket) state.payload.pain_bucket = parsed.painBucket;
    if (parsed.painNRS != null) state.payload.painScale = parsed.painNRS;

    const mergedNeg = new Set([...(state.payload.negations || []), ...(parsed.negations || [])]);
    state.payload.negations = Array.from(mergedNeg);

    if (!state.payload.domain && parsed.domainHint) state.payload.domain = parsed.domainHint;

    state.payload.freeText = parsed.cleanedText;
  }

  function hasParsedSignals() {
    return Boolean(
      state.payload.duration_norm ||
      state.payload.trajectory ||
      state.payload.fever_max_c != null ||
      state.payload.pain_bucket ||
      (state.payload.negations && state.payload.negations.length > 0)
    );
  }

  // --------------------------
  // Integração com ROBOTTO
  // --------------------------
  async function computeAndRespond() {
    try {
      hideQuickReplies();
      showTyping();

      let out;
      try {
        out = await window.ROBOTTO.run(state.payload, { rulesUrl: state.rulesUrl, forceLLM: false });
      } catch (e) {
        console.warn("ROBOTTO.run com rulesUrl falhou; tentando sem rulesUrl:", e);
        out = await window.ROBOTTO.run(state.payload, { forceLLM: false });
      }

      hideTyping();
      renderBotFromResult(out);
      ensureExportBtn().classList.remove("hidden");

      // Sugerir abrir checklist se ainda não abrimos e não houver sinais suficientes
      const needChecklist = (!state.askedSymptomsOnce &&
                            (!state.payload.symptoms || state.payload.symptoms.length === 0) &&
                            !hasParsedSignals());
      if (needChecklist) {
        state.askedSymptomsOnce = true;
        renderSymptoms();
        openOverlay("symptom-overlay");
      }

      // Abrir red flags uma única vez (sem bloquear cálculo)
      if (!state._flagsOpenedOnce && !state.flagsAnswered &&
          ((state.payload.symptoms && state.payload.symptoms.length > 0) || hasParsedSignals())) {
        state._flagsOpenedOnce = true;
        renderFlags();
        openOverlay("flag-overlay");
      }
    } catch (e) {
      hideTyping();
      console.error(e);
      addMessage("bot", "Desculpe, ocorreu um erro ao processar. Tente novamente em instantes.");
    }
  }

  function signatureOfResult(out) {
    try {
      const { local, backend } = out || {};
      if (backend && !(backend._error || backend.error) && Array.isArray(backend.differentials)) {
        const arr = backend.differentials.slice(0, 3).map(d => `${d.dx}:${Math.round((d.probability||0)*100)}`).join("|");
        return `B:${arr}`;
      }
      if (local?.top3?.length) {
        const arr = local.top3.map(d => `${d.dx}:${Math.round((d.norm||d.prob||0)*100)}`).join("|");
        return `L:${arr}`;
      }
    } catch (_) {}
    return "EMPTY";
  }

  // Pergunta SIM/NÃO contextual
  function askYesNo(question) {
    if (!question) return;
    if (state.lastAskedQuestion === question) return; // evita repetir
    state.lastAskedQuestion = question;

    addMessage("bot", `<strong>Pergunta rápida:</strong> ${question}`);
    setQuickReplies(["Sim", "Não", "Não sei"], (answer) => {
      const msg = `${question} — Resposta: ${answer}.`;
      inputEl.value = msg;
      document.getElementById("input-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function renderBotFromResult(out) {
    const sig = signatureOfResult(out);
    if (sig === state.lastRenderSig) return; // evita duplicar
    state.lastRenderSig = sig;

    const { local, backend } = out || {};
    let html = "";

    const hasBackendFlags = Array.isArray(backend?.red_flags) && backend.red_flags.length > 0;
    if (hasBackendFlags) {
      html += `<p class="mb-2"><strong>⚠️ Sinais de alerta:</strong> ${backend.red_flags.join("; ")}</p>`;
    }

    if (backend && !(backend._error || backend.error) && Array.isArray(backend.differentials)) {
      html += `<p class="mb-1"><strong>Diagnósticos diferenciais:</strong></p><ul class="ml-4 list-disc">`;
      backend.differentials.slice(0, 3).forEach(d => {
        const pct = Math.round((d.probability || 0) * 100);
        const rationale = d.rationale ? ` — <em>${d.rationale}</em>` : "";
        html += `<li>${d.dx} (${pct}%)${rationale}</li>`;
      });
      html += `</ul>`;
    } else if (local?.top3?.length) {
      html += `<p class="mb-1"><strong>Hipóteses iniciais (automático):</strong></p><ul class="ml-4 list-disc">`;
      local.top3.forEach(d => {
        const pct = Math.round((d.norm || d.prob || 0) * 100);
        html += `<li>${d.dx} (${pct}%)</li>`;
      });
      html += `</ul>`;
      if (out?.backend && (out.backend._error || out.backend.error)) {
        html += `<p class="mt-2 text-xs opacity-70">Servidor de apoio indisponível no momento; exibindo estimativa local.</p>`;
      }
    } else {
      html += `<p>Continuo coletando informações. Conte mais sobre seus sintomas (início, intensidade, fatores que pioram/melhoram).</p>`;
    }

    if (backend && !(backend._error || backend.error) && Array.isArray(backend.next_steps) && backend.next_steps.length) {
      html += `<p class="mt-2 mb-1"><strong>Próximos passos sugeridos:</strong></p><ul class="ml-4 list-disc">`;
      backend.next_steps.forEach(s => html += `<li>${s}</li>`);
      html += `</ul>`;
    }

    if (backend && !(backend._error || backend.error) && backend.care_level) {
      const label = backend.care_level === "emergency" ? "Emergência"
                  : backend.care_level === "urgency"   ? "Urgência" : "Rotina";
      html += `<p class="mt-2"><strong>Nível de cuidado:</strong> ${label}</p>`;
    }
    if (backend && !(backend._error || backend.error) && backend.safety_note) {
      html += `<p class="mt-1 text-sm opacity-80"><em>${backend.safety_note}</em></p>`;
    }

    // Pergunta fechada (prioriza backend; senão, usa gaps locais)
    let ynAsked = false;
    if (backend?.query_suggestions?.questions?.length) {
      const q = backend.query_suggestions.questions[0];
      if (q?.text) { askYesNo(q.text); ynAsked = true; }
    }
    if (!ynAsked && Array.isArray(local?.gaps?.questions) && local.gaps.questions.length) {
      askYesNo(local.gaps.questions[0]);
    }

    // Quick replies focadas no que falta
    const suggestions = [];
    if (!state.payload.duration_norm) suggestions.push("Começaram há __ dias e desde então [pioraram/melhoraram/estão iguais].");
    if (!state.payload.trajectory) suggestions.push("Desde o início, os sintomas estão [piorando/melhorando/iguais].");
    if (state.payload.fever_max_c == null && !/afebril/i.test(state.payload.freeText)) suggestions.push("Teve febre? Máxima de __ °C.");
    if (!state.payload.pain_bucket && !state.payload.painScale) suggestions.push("Dor [leve/moderada/intensa] ou __/10.");
    if (suggestions.length && !ynAsked) setQuickReplies(suggestions); else if (!ynAsked) hideQuickReplies();

    addMessage("bot", html || "Ok! Pode me contar mais detalhes?");
  }

  // --------------------------
  // Relatório (PDF/print)
  // --------------------------
  let exportBtn = null;
  function ensureExportBtn() {
    if (exportBtn) return exportBtn;
    exportBtn = document.createElement("button");
    exportBtn.id = "export-report";
    exportBtn.type = "button";
    exportBtn.textContent = "Gerar relatório (PDF)";
    exportBtn.className = "mb-2 hidden rounded bg-green-600 px-3 py-1 text-white";
    const footer = document.querySelector("footer");
    const qr = document.getElementById("quick-replies");
    footer.insertBefore(exportBtn, qr);
    exportBtn.addEventListener("click", handleExportPDF);
    return exportBtn;
  }

  function handleExportPDF() {
    try {
      const last = (window.ROBOTTO && window.ROBOTTO.last && window.ROBOTTO.last()) || null;
      const backend = last?.backend;
      const local = last?.local;

      let body = `<h1 style="font:600 18px system-ui;margin:0 0 8px">Relatório de Triagem – OTTO</h1>`;
      body += `<p style="margin:0 0 12px">Gerado em ${new Date().toLocaleString()}</p>`;

      const demo = [];
      if (state.payload.age != null) demo.push(`Idade: ${state.payload.age} anos`);
      if (state.payload.sex) demo.push(`Sexo: ${state.payload.sex}`);
      if (state.payload.duration_norm) demo.push(`Duração: ${state.payload.duration_norm}`);
      if (state.payload.trajectory) demo.push(`Trajetória: ${state.payload.trajectory}`);
      if (state.payload.fever_max_c != null) demo.push(`Tmax: ${state.payload.fever_max_c} °C`);
      if (demo.length) body += `<p>${demo.join(" • ")}</p>`;

      if (backend?.differentials?.length) {
        body += `<h2 style="font:600 16px system-ui;margin:16px 0 6px">Diagnósticos diferenciais</h2><ul>`;
        backend.differentials.slice(0,3).forEach(d=>{
          const pct = Math.round((d.probability||0)*100);
          const r = d.rationale ? ` — ${d.rationale}` : "";
          body += `<li>${d.dx} (${pct}%)${r}</li>`;
        });
        body += `</ul>`;
      } else if (local?.top3?.length) {
        body += `<h2 style="font:600 16px system-ui;margin:16px 0 6px">Hipóteses iniciais</h2><ul>`;
        local.top3.forEach(d=>{
          const pct = Math.round((d.norm||d.prob||0)*100);
          body += `<li>${d.dx} (${pct}%)</li>`;
        });
        body += `</ul>`;
      }

      if (backend?.next_steps?.length) {
        body += `<h2 style="font:600 16px system-ui;margin:16px 0 6px">Próximos passos</h2><ul>`;
        backend.next_steps.forEach(s=> body += `<li>${s}</li>`);
        body += `</ul>`;
      }
      if (backend?.care_level) {
        const label = backend.care_level === "emergency" ? "Emergência"
                    : backend.care_level === "urgency"   ? "Urgência" : "Rotina";
        body += `<p><strong>Nível de cuidado:</strong> ${label}</p>`;
      }
      if (backend?.safety_note) {
        body += `<p style="opacity:.8"><em>${backend.safety_note}</em></p>`;
      }
      if (last?.local?.references?.length) {
        body += `<h2 style="font:600 16px system-ui;margin:16px 0 6px">Referências</h2><ol>`;
        last.local.references.forEach(r => { body += `<li>${r}</li>`; });
        body += `</ol>`;
      }

      const w = window.open("", "_blank");
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Relatório OTTO</title></head><body style="font:14px system-ui;line-height:1.5;padding:24px">${body}</body></html>`);
      w.document.close();
      w.focus();
      w.print();
    } catch (e) {
      console.error(e);
      alert("Não foi possível gerar o relatório agora.");
    }
  }

  // --------------------------
  // Consentimento + Mini-intake
  // --------------------------
  $("#lgpd-checkbox")?.addEventListener("change", (e) => {
    const btn = $("#start-btn");
    if (!btn) return;
    btn.disabled = !e.target.checked;
    btn.classList.toggle("opacity-50", !e.target.checked);
  });

  $("#start-btn")?.addEventListener("click", () => {
    state.consented = true;
    document.getElementById("consent")?.classList.add("hidden");
    addMessage("bot", "Olá! Eu sou o OTTO. Vou tentar entender o seu quadro para orientar com segurança. 😊");

    // Mini-intake
    const mini = document.getElementById("mini-intake");
    const miniForm = document.getElementById("mini-intake-form");
    const ageInput = document.getElementById("mini-age");
    const miniSkip = document.getElementById("mini-intake-skip");

    if (mini && miniForm && ageInput) {
      mini.classList.remove("hidden");
      mini.classList.add("flex");

      const closeMini = () => { mini.classList.add("hidden"); mini.classList.remove("flex"); };

      miniForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const age = parseInt(String(ageInput.value || "").trim(), 10);
        const sexChecked = document.querySelector('input[name="mini-sex"]:checked');
        const sexVal = sexChecked ? sexChecked.value : "";

        if (!Number.isNaN(age) && age >= 0 && age <= 120) state.payload.age = age;
        if (/^f$/i.test(sexVal)) state.payload.sex = "F";
        else if (/^m$/i.test(sexVal)) state.payload.sex = "M";
        else state.payload.sex = "OUTRO";

        closeMini();
        addMessage("bot", "Obrigado! Idade e sexo registrados. Agora, selecione sintomas ou descreva o que sente.");
        // Abrir seleção de sintomas imediatamente
        renderSymptoms();
        openOverlay("symptom-overlay");
      });

      miniSkip?.addEventListener("click", () => {
        closeMini();
        addMessage("bot", "Tudo bem. Se preferir, pode informar sua idade/sexo por texto mais tarde.");
      });
    } else {
      // Fallback por chat
      addMessage("bot", "Antes de começarmos, informe por favor sua idade e sexo (biológico). Ex.: “32 anos, feminino”.");
    }
  });

  $("#theme-toggle")?.addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("otto_theme", document.body.classList.contains("dark") ? "dark" : "light");
  });
  (function initTheme() {
    const saved = localStorage.getItem("otto_theme");
    if (saved === "dark") document.body.classList.add("dark");
  })();

  $("#reset-btn")?.addEventListener("click", () => location.reload());

  // --------------------------
  // Overlays: sintomas
  // --------------------------
  const reviewBtn = $("#review-symptoms");
  if (reviewBtn) reviewBtn.textContent = "Selecionar sintomas";

  $("#review-symptoms")?.addEventListener("click", () => {
    renderSymptoms();
    openOverlay("symptom-overlay");
  });

  $("#skip-symptoms")?.addEventListener("click", () => {
    closeOverlay("symptom-overlay");
    // não bloqueia cálculo; se nunca mostramos flags, mostrar agora
    if (!state._flagsOpenedOnce) {
      state._flagsOpenedOnce = true;
      renderFlags();
      openOverlay("flag-overlay");
    } else {
      computeAndRespond();
    }
  });

  $("#symptom-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const sel = Array.from(document.querySelectorAll("#symptom-options input[type=checkbox]:checked"))
                     .map(i => i.value);
    state.payload.symptoms = sel;
    closeOverlay("symptom-overlay");

    const picked = sel.map(k => (SYMPTOMS_UI.find(s => s.key === k)?.label || k));
    if (picked.length) addMessage("bot", `Ok. Sintomas selecionados: ${picked.join(", ")}.`);

    // abrir flags uma vez, sem bloquear cálculo
    if (!state._flagsOpenedOnce) {
      state._flagsOpenedOnce = true;
      renderFlags();
      openOverlay("flag-overlay");
    }
    computeAndRespond();
  });

  // --------------------------
  // Overlays: red flags
  // --------------------------
  $("#flag-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const none = $("#no-flags");
    if (none && none.checked) state.payload.red_flags_reported = [];
    else {
      const sel = Array.from(document.querySelectorAll("#flag-options input[type=checkbox]:checked"))
                       .map(i => i.value);
      state.payload.red_flags_reported = sel;
    }
    state.flagsAnswered = true;
    closeOverlay("flag-overlay");

    addMessage("bot", "Obrigado. Vou analisar suas informações.");
    computeAndRespond();
  });

  // --------------------------
  // Form de envio (chat)
  // --------------------------
  $("#input-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = (inputEl.value || "").trim();
    if (!msg) return;
    inputEl.value = "";
    addMessage("user", msg);

    // acumula texto bruto e processa
    state.payload.freeTextOriginal = (state.payload.freeTextOriginal ? (state.payload.freeTextOriginal + " ") : "") + msg;

    // parser → estado
    const parsed = parseClinicalText(state.payload.freeTextOriginal);
    applyParsedToState(parsed);

    // heurística: se só capturou demografia e nada clínico, orientar para sintomas (sem flags)
    const onlyDemo =
      ((parsed.demographics?.age != null || parsed.demographics?.sex) &&
       !parsed.durationNorm && !parsed.trajectory && parsed.feverMaxC == null &&
       (!state.payload.symptoms || state.payload.symptoms.length === 0));

    if (onlyDemo) {
      renderSymptoms();
      openOverlay("symptom-overlay");
      return;
    }

    // se nunca abrimos flags e já há conteúdo clínico, abre flags (não bloqueia cálculo)
    if (!state._flagsOpenedOnce &&
        ((state.payload.symptoms && state.payload.symptoms.length > 0) || hasParsedSignals())) {
      state._flagsOpenedOnce = true;
      renderFlags();
      openOverlay("flag-overlay");
    }

    await computeAndRespond();
  });

  // Esconder splash ao carregar
  window.addEventListener("load", () => {
    const s = document.getElementById("splash-otto");
    if (!s) return;
    setTimeout(() => s.classList.add("fade-out"), 900);
  });

  // Mensagem inicial (antes do consentimento)
  addMessage("bot", "Bem-vindo(a)! Para começar, confirme o consentimento LGPD.");
})();
