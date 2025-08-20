/* app-ui.js - Orquestração da UI do OTTO (flow, perguntas, cards e integração com diagnostics/robotto)
   Blueprint aplicado: máquina de estados, pergunta ativa única, gating de cálculo e cartões substituíveis.
   Autor: você 💙
*/

(() => {
  // -------------------------------
  // Utilitários
  // -------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const formatPct = (p) => `${Math.round(p * 100)}%`;

  const deepClone = (o) => JSON.parse(JSON.stringify(o || {}));

  const hash = (obj) => {
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).slice(0, 32); }
    catch { return String(Date.now()); }
  };

  // -------------------------------
  // Catálogos (síntomas e red flags)
  // -------------------------------
  const SYMPTOM_OPTIONS = [
    { id: "febre", label: "Febre" },
    { id: "tosse", label: "Tosse" },
    { id: "dor_de_cabeca", label: "Dor de cabeça" },
    { id: "nariz_entupido", label: "Nariz entupido" },
    { id: "coriza", label: "Coriza ou Catarro" },
    { id: "mau_cheiro", label: "Mau cheiro" },
    { id: "dor_de_garganta", label: "Dor de garganta" },
    { id: "linfonodos_cervicais", label: "Ínguas no pescoço" },
    { id: "otalgia", label: "Dor de ouvido" },
    { id: "otorreia", label: "Secreção no ouvido" },
    { id: "hipoacusia", label: "Dificuldade de ouvir" },
    { id: "plenitude_auricular", label: "Plenitude/pressão no ouvido" },
    { id: "tontura", label: "Tontura/Vertigem" },
    { id: "pressao_na_face", label: "Pressão/dor na face" },
    { id: "espirros", label: "Espirros" },
    { id: "prurido_nasal", label: "Coceira no nariz" },
    { id: "redu_olfato", label: "Redução do olfato" },
    { id: "redu_paladar", label: "Redução do paladar" },
  ];

  const FLAG_OPTIONS = [
    { id: "dispneia", label: "Falta de ar / dificuldade para respirar" },
    { id: "dor_insuportavel", label: "Dor muito intensa / insuportável" },
    { id: "sangramento_volumoso", label: "Sangramento volumoso" },
    { id: "rigidez_pescoco", label: "Rigidez de pescoço" },
    { id: "turvacao_visual", label: "Turvação visual súbita" },
    { id: "palpitacao", label: "Palpitação" },
    { id: "desmaio", label: "Sensação de desmaio" },
  ];

  // -------------------------------
  // Estado global
  // -------------------------------
  const state = {
    ui: {
      flow: "CONSENT", // CONSENT → MINI_INTAKE → COLLECT_SYMPTOMS → COLLECT_FLAGS → ASKING → READY_TO_SCORE → SHOWING_RESULT → DONE
      asking: null,    // { id, text, options?, kind? }
      lastResult: null, // último resultado renderizado (local/LLM)
      lastHash: null,   // hash do último ctx que calculamos
      lastLLMHash: null,// hash do último ctx enviado ao LLM
      progress: 0,
    },
    ctx: {
      // Contexto canônico para diagnostics/LLM
      age: null,
      sex: null, // "M" | "F" | "OUTRO"
      symptoms: [],
      redFlags: [],
      freeText: "",
      timeline: { dur_days: null, trend: null }, // trend: "piorando" | "melhorando" | "iguais" | null
      fever: { hasFever: null, maxC: null },
      domainHint: null, // "garganta"|"nariz"|"ouvido"|"pescoço"|"laringe"|null
      lastCompute: { engine: null, hash: null },
    },
  };

  // -------------------------------
  // Referências DOM
  // -------------------------------
  const els = {
    consent: $("#consent"),
    lgpdCheckbox: $("#lgpd-checkbox"),
    startBtn: $("#start-btn"),

    miniIntake: $("#mini-intake"),
    miniForm: $("#mini-intake-form"),
    miniAge: $("#mini-age"),
    miniSkip: $("#mini-intake-skip"),

    symptomOverlay: $("#symptom-overlay"),
    symptomForm: $("#symptom-form"),
    symptomOptions: $("#symptom-options"),
    symptomSkip: $("#skip-symptoms"),

    flagOverlay: $("#flag-overlay"),
    flagForm: $("#flag-form"),
    flagOptions: $("#flag-options"),
    noFlags: $("#no-flags"),

    chat: $("#messages"),
    progress: $("#progress"),
    inputForm: $("#input-form"),
    userInput: $("#user-input"),
    reviewSymptomsBtn: $("#review-symptoms"),
    quickReplies: $("#quick-replies"),

    resetBtn: $("#reset-btn"),
    themeToggle: $("#theme-toggle"),
  };

  // -------------------------------
  // Render helpers (chat/cards)
  // -------------------------------
  function botBubble(html, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "flex gap-3";

    const avatar = document.createElement("div");
    avatar.innerHTML = `<img src="assets/otto-rounded.png" alt="OTTO" class="h-7 w-7 rounded-full ring-2 ring-sky-500/50 select-none" draggable="false"/>`;
    const bubble = document.createElement("div");
    bubble.className = "rounded-lg bg-white p-3 text-sm shadow dark:bg-gray-800";
    bubble.innerHTML = html;

    if (opts.id) wrap.dataset.cardId = opts.id;
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    return wrap;
  }

  function userBubble(text) {
    const wrap = document.createElement("div");
    wrap.className = "flex justify-end";
    const bubble = document.createElement("div");
    bubble.className = "max-w-[80%] rounded-lg bg-sky-600 p-3 text-sm text-white shadow";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    return wrap;
  }

  function appendMessage(el) {
    els.chat.appendChild(el);
    requestAnimationFrame(() => {
      els.chat.scrollTop = els.chat.scrollHeight + 1000;
    });
  }

  function replaceOrAppendCard(type, html) {
    // type: 'flags' | 'dx' | 'question'
    // Atualiza cartão existente (data-card-id) ou adiciona novo
    const selector = `[data-card-id="${type}"]`;
    let card = els.chat.querySelector(selector);
    const node = botBubble(html, { id: type });
    if (card) {
      els.chat.replaceChild(node, card);
    } else {
      appendMessage(node);
    }
  }

  function clearQuestionCard() {
    const q = els.chat.querySelector('[data-card-id="question"]');
    if (q) q.remove();
  }

  function setProgress(p) {
    state.ui.progress = clamp01(p);
    if (els.progress) els.progress.value = state.ui.progress;
  }

  // -------------------------------
  // Overlays (show/hide & build lists)
  // -------------------------------
  function showOverlay(id, show) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el) return;
    el.classList.toggle("hidden", !show);
    el.classList.toggle("flex", show);
  }

  function buildOptionsList(container, items, groupName) {
    container.innerHTML = "";
    items.forEach((it) => {
      const id = `${groupName}-${it.id}`;
      const row = document.createElement("label");
      row.className = "flex items-center gap-3";
      row.innerHTML = `
        <input type="checkbox" id="${id}" data-id="${it.id}" class="h-4 w-4">
        <span>${it.label}</span>
      `;
      container.appendChild(row);
    });
  }

  // -------------------------------
  // Quick replies (para pergunta ativa)
  // -------------------------------
  function setQuickReplies(items) {
    els.quickReplies.innerHTML = "";
    items.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rounded-full border px-3 py-1 text-sm dark:border-gray-600 dark:bg-gray-700";
      btn.textContent = opt.label;
      btn.dataset.value = opt.value;
      btn.addEventListener("click", () => {
        handleAnswer(opt.value, opt.label);
      });
      els.quickReplies.appendChild(btn);
    });
  }

  function hideQuickReplies() {
    els.quickReplies.innerHTML = "";
  }

  // -------------------------------
  // Máquina de estados / eventos
  // -------------------------------
  function dispatch(event, payload = {}) {
    switch (event) {
      case "CONSENT_OK":
        state.ui.flow = "MINI_INTAKE";
        showOverlay(els.consent, false);
        showOverlay(els.miniIntake, true);
        break;

      case "MINI_INTAKE_DONE": {
        showOverlay(els.miniIntake, false);
        mergeContext({ age: payload.age || null, sex: payload.sex || null });
        state.ui.flow = "COLLECT_SYMPTOMS";
        setProgress(0.25);

        appendMessage(botBubble(
          `<p>Olá! Eu sou o OTTO. Você pode escrever livremente seus sintomas ou usar o botão <em>Revisar sintomas</em>. Ambos funcionam juntos. 😊</p>`
        ));
        appendMessage(botBubble(
          `<p>Assim que você descrever ou marcar alguns sintomas, eu sigo com perguntas rápidas e vou calcular as hipóteses.</p>`
        ));
        break;
      }

      case "OPEN_SYMPTOM_PICKER":
        buildOptionsList(els.symptomOptions, SYMPTOM_OPTIONS, "sym");
        // pré-seleciona os já escolhidos
        state.ctx.symptoms.forEach((sid) => {
          const cb = $(`#sym-${CSS.escape(sid)}`);
          if (cb) cb.checked = true;
        });
        showOverlay(els.symptomOverlay, true);
        break;

      case "SYMPTOMS_SELECTED": {
        showOverlay(els.symptomOverlay, false);
        const selected = $$("#symptom-options input[type='checkbox']:checked").map((el) => el.dataset.id);
        // regra: se marcou "febre" no picker, setar hasFever=true (sem duplicar pergunta)
        const hasFever = selected.includes("febre");
        mergeContext({
          symptoms: Array.from(new Set(selected)),
          fever: { ...state.ctx.fever, hasFever: hasFever ? true : state.ctx.fever.hasFever }
        });
        if (state.ui.flow === "COLLECT_SYMPTOMS") state.ui.flow = "COLLECT_FLAGS";
        // Convida a confirmar sinais de alerta
        appendMessage(botBubble(`<p>Obrigado. Agora, marque se há algum sinal de alerta importante.</p>`));
        dispatch("OPEN_FLAG_PICKER");
        break;
      }

      case "OPEN_FLAG_PICKER":
        buildOptionsList(els.flagOptions, FLAG_OPTIONS, "flag");
        els.noFlags.checked = state.ctx.redFlags.length === 0;
        // pré-seleciona
        state.ctx.redFlags.forEach((fid) => {
          const cb = $(`#flag-${CSS.escape(fid)}`);
          if (cb) cb.checked = true;
        });
        showOverlay(els.flagOverlay, true);
        break;

      case "FLAGS_SELECTED": {
        showOverlay(els.flagOverlay, false);
        const none = els.noFlags.checked;
        const flags = none ? [] : $$("#flag-options input[type='checkbox']:checked").map(el => el.dataset.id);
        mergeContext({ redFlags: flags });
        // Ready para cálculo
        state.ui.flow = "READY_TO_SCORE";
        maybeCompute(); // dispara cálculo com gating
        break;
      }

      case "TEXT_SUBMITTED": {
        // adiciona no chat
        appendMessage(userBubble(payload.text));
        // mescla freeText e roda parser para preencher timeline/fever/etc
        mergeFreeText(payload.text);
        // se estiver perguntando algo e a pergunta requer resposta de múltipla escolha,
        // não tentaremos interpretar o texto como resposta automática agora.
        maybeCompute();
        break;
      }

      case "ASK": {
        // Mostra somente UMA pergunta ativa e quick replies
        state.ui.asking = payload; // { id, text, options? }
        state.ui.flow = "ASKING";
        const opts = (payload.options && payload.options.length)
          ? payload.options.map((o) => ({ label: o, value: o }))
          : [{ label: "Sim", value: "sim" }, { label: "Não", value: "nao" }, { label: "Não sei", value: "nao_sei" }];

        replaceOrAppendCard("question", `<p><strong>Pergunta rápida:</strong> ${payload.text}</p>`);
        setQuickReplies(opts);
        break;
      }

      case "ANSWERED": {
        // payload: { qid, value, label }
        hideQuickReplies();
        clearQuestionCard();
        state.ui.asking = null;
        state.ui.flow = "READY_TO_SCORE";
        appendMessage(userBubble(payload.label || String(payload.value)));
        // aplica no contexto
        applyAnswerToContext(payload.qid, payload.value);
        setProgress(0.7);
        maybeCompute();
        break;
      }

      case "RESET":
        location.reload();
        break;

      default:
        // no-op
        break;
    }
  }

  // -------------------------------
  // Context helpers
  // -------------------------------
  function mergeContext(partial) {
    state.ctx = {
      ...state.ctx,
      ...deepClone(partial),
      // Mescla de objetos filhos
      timeline: { ...state.ctx.timeline, ...(partial.timeline || {}) },
      fever: { ...state.ctx.fever, ...(partial.fever || {}) },
    };
  }

  function mergeFreeText(text) {
    // Anexa ao freeText e tenta parsear via diagnostics (se disponível)
    const joined = (state.ctx.freeText ? state.ctx.freeText + "\n" : "") + text;
    mergeContext({ freeText: joined });

    if (window.DIAGNOSTICS && typeof window.DIAGNOSTICS.parseAndMerge === "function") {
      try {
        const updated = window.DIAGNOSTICS.parseAndMerge(deepClone(state.ctx), text);
        mergeContext(updated);
      } catch (e) {
        console.warn("parseAndMerge falhou:", e);
      }
    } else {
      // fallback mínimo: detectar febre em texto
      if (/febre/i.test(text) && state.ctx.fever.hasFever === null) {
        mergeContext({ fever: { ...state.ctx.fever, hasFever: true } });
      }
      const mDur = text.match(/(\d+)\s*(dias?|semanas?)/i);
      if (mDur) {
        const n = parseInt(mDur[1], 10);
        const unit = (mDur[2] || "").toLowerCase();
        const days = /semana/.test(unit) ? n * 7 : n;
        mergeContext({ timeline: { ...state.ctx.timeline, dur_days: days } });
      }
      if (/\bpior(a|ando)\b/i.test(text)) mergeContext({ timeline: { ...state.ctx.timeline, trend: "piorando" } });
      if (/\bmelhor(a|ando)\b/i.test(text)) mergeContext({ timeline: { ...state.ctx.timeline, trend: "melhorando" } });
    }
  }

  function applyAnswerToContext(qid, value) {
    switch (qid) {
      case "fever_today":
        mergeContext({ fever: { ...state.ctx.fever, hasFever: value === "sim" ? true : value === "nao" ? false : state.ctx.fever.hasFever } });
        break;
      case "fever_max":
        // value esperado como string ">=38" | "<38" | "nao_sei"
        if (value === ">=38") mergeContext({ fever: { ...state.ctx.fever, maxC: 38.0 } });
        else if (value === "<38") mergeContext({ fever: { ...state.ctx.fever, maxC: 37.5 } });
        break;
      case "trend":
        // "piorando"|"melhorando"|"iguais"
        mergeContext({ timeline: { ...state.ctx.timeline, trend: value } });
        break;
      case "onset_vertigo":
        // "subita" | "episodios"
        mergeContext({ domainHint: "ouvido" });
        break;
      default:
        // outras perguntas futuras…
        break;
    }
  }

  // -------------------------------
  // Cálculo (gating + local + LLM)
  // -------------------------------
  function shouldCompute() {
    const { age, sex, symptoms, freeText, redFlags } = state.ctx;
    if (!age || !sex) return false;
    const hasPayload = (symptoms && symptoms.length > 0) || (freeText && freeText.trim().length >= 8) || (redFlags && redFlags.length > 0);
    if (!hasPayload) return false;
    if (state.ui.asking) return false; // aguarde resposta
    return true;
  }

  async function maybeCompute() {
    if (!shouldCompute()) return;

    const computeHash = hash({
      age: state.ctx.age,
      sex: state.ctx.sex,
      symptoms: state.ctx.symptoms,
      redFlags: state.ctx.redFlags,
      freeText: state.ctx.freeText,
      timeline: state.ctx.timeline,
      fever: state.ctx.fever,
    });

    if (state.ui.lastHash === computeHash) return; // evita recomputar idêntico
    state.ui.lastHash = computeHash;

    // 1) Local score primeiro
    let local = null;
    if (window.DIAGNOSTICS && typeof window.DIAGNOSTICS.localScore === "function") {
      try {
        local = window.DIAGNOSTICS.localScore(deepClone(state.ctx));
      } catch (e) {
        console.warn("localScore falhou:", e);
      }
    }
    if (!local) {
      local = {
        differentials: [{ dx: "IVAS viral", probability: 0.6, rationale: "Estimativa local" }],
        red_flags: [],
        next_steps: ["Hidratação, analgésico/antitérmico se necessário."],
        care_level: "routine",
        askNext: null,
        needsLLM: true,
      };
    }

    // 1a) Render flags e diagnósticos (cartões substituíveis)
    renderFlagsCard(local.red_flags || []);
    renderDxCard(local);

    // 1b) Se existe pergunta de follow-up, pergunte e pare aqui
    if (local.askNext && local.askNext.id) {
      dispatch("ASK", local.askNext);
      return;
    }

    // 2) Chamar LLM se fizer sentido (balanced) e não for repetição
    if (shouldCallLLM(local)) {
      await refineWithLLM(local);
    } else {
      state.ui.flow = "SHOWING_RESULT";
      state.ui.lastResult = local;
      setProgress(1);
    }
  }

  function shouldCallLLM(local) {
    // Política "balanced": chama se local marcou needsLLM, ou se não há sintomas fortes, ou se há conflito
    const h = hash({
      h: state.ui.lastLLMHash,
      age: state.ctx.age,
      sex: state.ctx.sex,
      symptoms: state.ctx.symptoms,
      redFlags: state.ctx.redFlags,
      timeline: state.ctx.timeline,
      fever: state.ctx.fever,
      freeTextLen: (state.ctx.freeText || "").length,
    });
    const newHash = h.slice(0, 28);
    if (state.ui.lastLLMHash === newHash) return false;

    const needs = !!(local && local.needsLLM);
    const lowSignal = (state.ctx.symptoms || []).length < 2 && (state.ctx.freeText || "").length < 40;
    const conflicting = (local && local.differentials && local.differentials.length >= 3 && Math.abs(local.differentials[0].probability - local.differentials[1].probability) < 0.08);

    return needs || lowSignal || conflicting;
  }

  async function refineWithLLM(localAlreadyRendered) {
    // mostra spinner fino no cartão de dx
    addSpinnerToDx(true);

    const llmPayload = deepClone(state.ctx);
    let llmResult = null;
    try {
      if (window.ROBOTTO && typeof window.ROBOTTO.callLLM === "function") {
        llmResult = await window.ROBOTTO.callLLM(llmPayload);
      }
    } catch (e) {
      console.warn("ROBOTTO.callLLM erro:", e);
    }

    addSpinnerToDx(false);

    if (llmResult && llmResult.differentials) {
      renderDxCard(llmResult, { fromLLM: true });
      renderFlagsCard(llmResult.red_flags || []);
      state.ui.flow = "SHOWING_RESULT";
      state.ui.lastResult = llmResult;
      state.ui.lastLLMHash = hash({
        age: state.ctx.age, sex: state.ctx.sex, symptoms: state.ctx.symptoms,
        redFlags: state.ctx.redFlags, timeline: state.ctx.timeline, fever: state.ctx.fever,
        freeTextLen: (state.ctx.freeText || "").length
      }).slice(0, 28);
      setProgress(1);
    } else {
      // mantém local
      state.ui.flow = "SHOWING_RESULT";
      state.ui.lastResult = localAlreadyRendered || state.ui.lastResult;
      setProgress(1);
    }
  }

  // -------------------------------
  // Cartões (flags, dx)
  // -------------------------------
  function renderFlagsCard(flags) {
    if (!flags || flags.length === 0) {
      // Limpa cartão se não houver flags
      replaceOrAppendCard("flags", `<p><strong>Sinais de alerta:</strong> nenhum sinal de alerta informado.</p>`);
      return;
    }
    const lis = flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("");
    replaceOrAppendCard("flags", `
      <div>
        <p><strong>⚠️ Sinais de alerta:</strong></p>
        <ul class="mt-1 list-disc pl-5">${lis}</ul>
      </div>
    `);
  }

  function renderDxCard(result, opts = {}) {
    const diffs = result.differentials || [];
    const items = diffs.map(d => {
      const pct = typeof d.probability === "number" ? formatPct(d.probability) : "";
      const rationale = d.rationale ? ` — <em>${escapeHtml(d.rationale)}</em>` : "";
      return `<li><strong>${escapeHtml(d.dx)}</strong> (${pct})${rationale}</li>`;
    }).join("");

    const care = result.care_level ? `<p class="mt-2"><strong>Nível de cuidado:</strong> ${escapeHtml(capitalizeCare(result.care_level))}</p>` : "";
    const note = result.safety_note ? `<p class="mt-1 text-sm italic opacity-80">${escapeHtml(result.safety_note)}</p>` : "";

    const refining = opts.fromLLM ? "" : `<span class="ml-2 text-xs opacity-70">${opts.refining ? "refinando…" : ""}</span>`;

    replaceOrAppendCard("dx", `
      <div>
        <p class="font-semibold">Diagnósticos diferenciais:${refining}</p>
        <ul class="mt-1 list-disc pl-5">${items}</ul>
        ${care}
        ${note}
      </div>
    `);
  }

  function addSpinnerToDx(on) {
    const node = els.chat.querySelector('[data-card-id="dx"]');
    if (!node) return;
    const bubble = node.querySelector("div > p.font-semibold");
    if (!bubble) return;
    const old = bubble.querySelector(".mini-spin");
    if (old) old.remove();
    if (on) {
      const span = document.createElement("span");
      span.className = "mini-spin ml-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent align-middle";
      bubble.appendChild(span);
    }
  }

  function capitalizeCare(lvl) {
    if (!lvl) return "";
    const map = { emergency: "Emergência", urgency: "Urgência", routine: "Rotina" };
    return map[lvl] || lvl;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // -------------------------------
  // Handlers de UI
  // -------------------------------
  els.startBtn?.addEventListener("click", () => {
    if (!els.lgpdCheckbox.checked) return;
    dispatch("CONSENT_OK");
  });

  els.miniForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const age = parseInt(els.miniAge.value, 10);
    const sex = ($("input[name='mini-sex']:checked") || {}).value || null;
    dispatch("MINI_INTAKE_DONE", { age, sex });
  });

  els.miniSkip?.addEventListener("click", () => {
    dispatch("MINI_INTAKE_DONE", { age: null, sex: null });
  });

  // Abrir seleção de sintomas
  els.reviewSymptomsBtn?.addEventListener("click", () => {
    dispatch("OPEN_SYMPTOM_PICKER");
  });

  els.symptomForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    dispatch("SYMPTOMS_SELECTED");
  });

  els.symptomSkip?.addEventListener("click", () => {
    showOverlay(els.symptomOverlay, false);
    // Mesmo sem sintomas, podemos seguir (gating impedirá cálculo até ter conteúdo)
    appendMessage(botBubble(`<p>Tudo bem! Você pode descrever em texto quando quiser.</p>`));
    if (state.ui.flow === "COLLECT_SYMPTOMS") state.ui.flow = "COLLECT_FLAGS";
    dispatch("OPEN_FLAG_PICKER");
  });

  // Red flags
  els.noFlags?.addEventListener("change", () => {
    if (els.noFlags.checked) {
      $$("#flag-options input[type='checkbox']").forEach(cb => (cb.checked = false));
    }
  });

  els.flagForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    dispatch("FLAGS_SELECTED");
  });

  // Envio de texto livre
  els.inputForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = (els.userInput.value || "").trim();
    if (!text) return;
    els.userInput.value = "";
    dispatch("TEXT_SUBMITTED", { text });
  });

  // Reset e tema
  els.resetBtn?.addEventListener("click", () => dispatch("RESET"));
  els.themeToggle?.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    localStorage.setItem("otto-theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
  });
  // restaura tema
  (function restoreTheme(){
    const saved = localStorage.getItem("otto-theme");
    if (saved === "dark") document.documentElement.classList.add("dark");
  })();

  // Responder pergunta (quick reply)
  async function handleAnswer(value, label) {
    const q = state.ui.asking;
    if (!q) return;
    dispatch("ANSWERED", { qid: q.id, value, label });
  }

  // -------------------------------
  // Boot inicial
  // -------------------------------
  async function boot() {
    // popula listas (uma vez)
    buildOptionsList(els.symptomOptions, SYMPTOM_OPTIONS, "sym");
    buildOptionsList(els.flagOptions, FLAG_OPTIONS, "flag");

    // mostra consent se ainda não aceitou nesta sessão
    showOverlay(els.consent, true);

    // mensagem inicial
    appendMessage(botBubble(`<p>Bem-vindo(a)! Para começar, confirme o consentimento LGPD.</p>`));
  }

  boot();

})();
