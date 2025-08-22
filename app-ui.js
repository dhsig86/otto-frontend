// ===========================================
// OTTO — UI (chat)  — app-ui.js
// Integra com window.ROBOTTO (robotto.js)
// ===========================================
document.addEventListener("DOMContentLoaded", function () {
  addMsgBubble();


(() => {
  // ---------- Atalhos de DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const elChat = $("#chat");
  const elMsgs = $("#messages");
  const elProgress = $("#progress");
  const elQuick = $("#quick-replies");
  const elForm = $("#input-form");
  const elInput = $("#user-input");
  const elReviewBtn = $("#review-symptoms");

  // Overlays
  const elConsent = $("#consent");
  const elStartBtn = $("#start-btn");
  const elMini = $("#mini-intake");
  const elMiniForm = $("#mini-intake-form");
  const elMiniAge = $("#mini-age");
  const elSymOverlay = $("#symptom-overlay");
  const elSymForm = $("#symptom-form");
  const elSymOpts = $("#symptom-options");
  const elSymSkip = $("#skip-symptoms");
  const elFlagOverlay = $("#flag-overlay");
  const elFlagForm = $("#flag-form");
  const elFlagOpts = $("#flag-options");
  const elNoFlags = $("#no-flags");
  const elResetBtn = $("#reset-btn");
  const elThemeToggle = $("#theme-toggle");

  // ---------- Configuração inicial ----------
  const container = document.getElementById("algum-id");
if (container) {
  container.appendChild(novoElemento);
} else {
  console.warn("Elemento não encontrado: algum-id");
}

  // ---------- Estado do caso ----------
  const state = {
    started: false,
    age: null,
    sex: null, // "M" | "F" | "OUTRO"
    domain: null,

    freeText: "",
    freeTextOriginal: "",
    symptoms: [],
    red_flags_reported: [],

    duration: null,          // texto livre normalizado (opcional)
    duration_days: null,     // numérico (opcional)
    trajectory: null,
    fever_max_c: null,
    negations: [],
    answeredQA: [],          // {q, a}

    // controle de entrevista
    interviewing: false,
    lastAsk: null,

    // telemetria do último run
    lastRun: null
  };

  // ---------- Vocabulários (com fallback) ----------
  const SYMPTOMS = (window.DIAG_SYMPTOMS || window.SYMPTOM_LIBRARY || [
    { id: "dor_de_garganta", label: "Dor de garganta" },
    { id: "placas_amigdalas", label: "Placas amigdalares" },
    { id: "dor_de_ouvido", label: "Dor de ouvido" },
    { id: "otorreia", label: "Secreção pelo ouvido" },
    { id: "tinnitus", label: "Zumbido (tinnitus)" },
    { id: "nariz_entupido", label: "Nariz entupido" },
    { id: "coriza", label: "Coriza/Catarro" },
    { id: "tosse", label: "Tosse" },
    { id: "dor_de_cabeca", label: "Dor de cabeça" },
    { id: "febre", label: "Febre" },
    { id: "rouquidao", label: "Rouco(a)/Sem voz" }, // disfonia
  ]);

  const RED_FLAGS = (window.DIAG_RED_FLAGS || [
    { id: "disfagia_importante", label: "Dificuldade importante para engolir (risco de obstrução)" },
    { id: "dispneia_importante", label: "Falta de ar importante" },
    { id: "estridor", label: "Estridor / ruído ao respirar" },
    { id: "voz_abafada", label: "Voz abafada ou babando saliva" },
    { id: "rigidez_pescoco", label: "Rigidez no pescoço" },
    { id: "sangramento_abundante", label: "Sangramento volumoso" },
    { id: "neurologico_subito", label: "Déficit neurológico súbito / forte cefaleia súbita" },
  ]);

  // ---------- Utilidades ----------
  const norm = (s) => (s || "").toLowerCase().trim();
  const uniq = (a) => Array.from(new Set(a || [])).filter(Boolean);

  function ensureVisibleBottom() {
    // Pequeno scroll suave para o fim do chat
    requestAnimationFrame(() => {
      elChat.scrollTo({ top: elChat.scrollHeight, behavior: "smooth" });
    });
  }

  function addMsgBubble(html, from = "bot") {
    const wrap = document.createElement("div");
    wrap.className = from === "user"
      ? "flex justify-end"
      : "flex justify-start";

    const inner = document.createElement("div");
    inner.className =
      from === "user"
        ? "max-w-[85%] rounded-2xl bg-sky-600 text-white px-4 py-2 shadow"
        : "max-w-[85%] rounded-2xl bg-white dark:bg-gray-800 px-4 py-2 shadow";
    inner.innerHTML = html;

    wrap.appendChild(inner);
    elMsgs.appendChild(wrap);
    ensureVisibleBottom();
    return inner;
  }

  function addCard(title, lines = []) {
    const ul = lines.map((l) => `<li class="ml-4 list-disc">${l}</li>`).join("");
    const html = `
      <div class="rounded-xl border border-gray-200 dark:border-gray-700 p-3">
        <div class="font-semibold mb-1">${title}</div>
        <ul class="text-sm leading-relaxed">${ul}</ul>
      </div>`;
    return addMsgBubble(html, "bot");
  }

  function showProgress(v) {
    elProgress.value = v;
  }

  function setQuickReplies(opts = []) {
    elQuick.innerHTML = "";
    if (!opts || !opts.length) return;
    for (const o of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rounded-full border px-3 py-1 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700";
      b.textContent = o;
      b.addEventListener("click", () => onUserQuickReply(o));
      elQuick.appendChild(b);
    }
  }

  function mirrorAgeSex() {
    const sx = state.sex === "M" ? "masculino" : state.sex === "F" ? "feminino" : "outro/não informado";
    addMsgBubble(`<span class="font-semibold">Anotei:</span> idade ${state.age ?? "n/d"} e sexo ${sx}.`, "bot");
  }

  function mirrorSymptomsAdded(list) {
    if (!list.length) return;
    addMsgBubble(`Adicionei: <span class="italic">${list.join(", ")}</span>`, "bot");
  }

  // ---------- Overlays ----------
  function openSymptomOverlay() {
    renderSymptomsOverlay();
    elSymOverlay.classList.remove("hidden");
  }
  function closeSymptomOverlay() { elSymOverlay.classList.add("hidden"); }

  function renderSymptomsOverlay() {
    elSymOpts.innerHTML = "";
    const selected = new Set(state.symptoms.map(norm));
    for (const s of SYMPTOMS) {
      const id = `sx_${s.id}`;
      const row = document.createElement("label");
      row.className = "flex items-center gap-2";
      row.innerHTML = `
        <input id="${id}" type="checkbox" ${selected.has(s.id) ? "checked" : ""} />
        <span>${s.label}</span>`;
      elSymOpts.appendChild(row);
    }
  }

  function openFlagsOverlay() {
    renderFlagsOverlay();
    elFlagOverlay.classList.remove("hidden");
  }
  function closeFlagsOverlay() { elFlagOverlay.classList.add("hidden"); }

  function renderFlagsOverlay() {
    elFlagOpts.innerHTML = "";
    const selected = new Set(state.red_flags_reported.map(norm));
    for (const f of RED_FLAGS) {
      const id = `rf_${f.id}`;
      const row = document.createElement("label");
      row.className = "flex items-center gap-2";
      row.innerHTML = `
        <input id="${id}" type="checkbox" ${selected.has(f.id) ? "checked" : ""} />
        <span>${f.label}</span>`;
      elFlagOpts.appendChild(row);
    }
    elNoFlags.checked = !selected.size;
  }

  // ---------- Integração com ROBOTTO ----------
  async function computeAndRender(opts = {}) {
    showProgress(0.25);
    // Monta payload
    const payload = {
      age: state.age ?? null,
      sex: state.sex ?? null,
      domain: state.domain ?? null,
      freeText: state.freeText,
      freeTextOriginal: state.freeTextOriginal,
      symptoms: uniq(state.symptoms),
      red_flags_reported: uniq(state.red_flags_reported),
      duration: state.duration ?? null,
      duration_days: state.duration_days ?? null,
      trajectory: state.trajectory ?? null,
      fever_max_c: state.fever_max_c ?? null,
      negations: uniq(state.negations),
      answeredQA: state.answeredQA
    };

    try {
      const r = await window.ROBOTTO.run(payload, { rulesUrl: "rules_otorrino.json", forceLLM: !!opts.forceLLM });
      state.lastRun = r;
      showProgress(0.65);

      // Se bloqueou por "apenas demografia": iniciar entrevista
      if (!r.meta.ready && r.meta.deferred_reason === "only_demographics") {
        greetingChiefComplaint();
        // quick start do entrevistador (pergunta 1)
        if (r.meta.ask_hint?.quickStart) {
          await askAndRender(r.meta.ask_hint.caseState, "", r.meta.ask_hint.goal || "next_question");
        }
        showProgress(1);
        return;
      }

      // Red flags (reportadas)
      if ((r.meta.red_flags_merged || []).length) {
        addCard("Sinais de alerta presentes:", (r.meta.red_flags_merged || []).map((x) => x));
      }

      // Hipóteses — blend local + backend
      const top3 = (r.local?.blendedTop3 || []).map(d =>
        `${d.dx} (${Math.round((d.probability || 0) * 100)}%)`
      );
      if (top3.length) addCard("Hipóteses principais", top3);

      // Próximas perguntas (sugestões)
      const qs = r.meta?.suggested_questions || [];
      if (qs.length) {
        setQuickReplies(qs[0].options || ["Sim", "Não"]);
        addMsgBubble(`<span class="font-semibold">Pergunta rápida:</span> ${qs[0].text}`, "bot");
        state.lastAsk = { text: qs[0].text, options: qs[0].options || ["Sim", "Não"] };
      } else {
        // Sem perguntas locais → podemos usar entrevistador para refinar
        if (r.meta?.ask_hint?.caseState) {
          await askAndRender(r.meta.ask_hint.caseState, "", r.meta.ask_hint.goal || "confirm_summary");
        }
      }
    } catch (e) {
      console.warn(e);
      addMsgBubble("Tive um problema para calcular agora. Tente novamente em instantes.", "bot");
    } finally {
      showProgress(1);
    }
  }

  async function askAndRender(caseState, lastUserText, goal = "next_question") {
    try {
      const out = await window.ROBOTTO.ask(caseState, lastUserText || "", goal, "breve");
      // Render pergunta e quick replies
      addMsgBubble(`<span class="font-semibold">Pergunta rápida:</span> ${out.assistant_text}`, "bot");
      setQuickReplies(out.quick_replies || ["Sim", "Não"]);
      state.interviewing = true;
      state.lastAsk = { text: out.assistant_text, options: out.quick_replies || [] };
    } catch (e) {
      console.warn("ask failed", e);
    }
  }

  // ---------- Fluxos de UI ----------
  function greeting() {
    addMsgBubble(
      `Olá! Eu sou o OTTO 👋. Confirme o consentimento e informe idade/sexo. Depois, escreva seus sintomas em uma frase e/ou abra a seleção para adicionar sintomas.`,
      "bot"
    );
    addMsgBubble(
      `Obrigado. Agora, descreva seus sintomas em uma frase (ex.: “dor de garganta há 5 dias, piorando, sem tosse”) ou abra a caixa para selecionar itens.`,
      "bot"
    );
  }

  function greetingChiefComplaint() {
    addMsgBubble(`<span class="font-semibold">Como posso ajudar hoje?</span> Escreva a sua queixa principal ou toque em <em>Revisar sintomas</em>.`, "bot");
  }

  // ---------- Manipuladores ----------
  // 1) Consentimento → mini-intake
  if (elStartBtn) {
    elStartBtn.addEventListener("click", () => {
      elConsent.classList.add("hidden");
      elMini.classList.remove("hidden");
    });
  }

  // 2) Mini-intake
  if (elMiniForm) {
    elMiniForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      state.age = Number(elMiniAge.value) || null;
      const sx = elMiniForm.querySelector('input[name="mini-sex"]:checked');
      state.sex = sx ? sx.value : null;
      elMini.classList.add("hidden");
      state.started = true;
      mirrorAgeSex();
      greetingChiefComplaint();
    });
    $("#mini-intake-skip")?.addEventListener("click", () => {
      elMini.classList.add("hidden");
      state.started = true;
      greetingChiefComplaint();
    });
  }

  // 3) Revisar sintomas
  if (elReviewBtn) {
    elReviewBtn.addEventListener("click", () => {
      openSymptomOverlay();
    });
  }

  // 4) Sintomas – submit/skip
  if (elSymForm) {
    elSymForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const picked = [];
      for (const s of SYMPTOMS) {
        const cb = document.getElementById(`sx_${s.id}`);
        if (cb && cb.checked) picked.push(s.id);
      }
      const newlyAdded = picked.filter((p) => !state.symptoms.includes(p));
      state.symptoms = uniq(picked);
      closeSymptomOverlay();
      mirrorSymptomsAdded(newlyAdded);
      // Após escolher sintomas, perguntar red flags
      openFlagsOverlay();
    });
  }
  if (elSymSkip) elSymSkip.addEventListener("click", () => closeSymptomOverlay());

  // 5) Red flags – submit
  if (elFlagForm) {
    elFlagForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const picked = [];
      for (const f of RED_FLAGS) {
        const cb = document.getElementById(`rf_${f.id}`);
        if (cb && cb.checked) picked.push(f.id);
      }
      state.red_flags_reported = elNoFlags.checked ? [] : uniq(picked);
      closeFlagsOverlay();

      // Espelho
      if (state.red_flags_reported.length) {
        addMsgBubble(`Sinais de alerta presentes: <span class="italic">${state.red_flags_reported.join(", ")}</span>`, "bot");
      } else {
        addMsgBubble(`<span class="font-semibold">Sinais de alerta:</span> nenhum sinal de alerta informado.`, "bot");
      }
      // Computa hipóteses
      await computeAndRender();
    });
  }

  // 6) Envio de mensagem do usuário
  if (elForm) {
    elForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = elInput.value.trim();
      if (!text) return;
      addMsgBubble(text, "user");
      elInput.value = "";

      // Se a UI estava em entrevista e há última pergunta, registra resposta
      if (state.interviewing && state.lastAsk?.text) {
        state.answeredQA.push({ q: state.lastAsk.text, a: text });
        state.interviewing = false;
        setQuickReplies([]);
      }

      // Captura super simples de sintomas por ID digitado (ex: "dor_de_ouvido, tinnitus")
      const newSx = [];
      text.split(/[,;]+/).map((s) => norm(s)).forEach((token) => {
        const hit = SYMPTOMS.find((s) => s.id === token);
        if (hit && !state.symptoms.includes(hit.id)) {
          state.symptoms.push(hit.id);
          newSx.push(hit.id);
        }
      });
      if (newSx.length) mirrorSymptomsAdded(newSx);

      // Atualiza texto livre
      state.freeTextOriginal = text;
      state.freeText = text;

      await computeAndRender();
    });
  }

  // 7) Quick replies
  async function onUserQuickReply(answer) {
    addMsgBubble(answer, "user");
    // Se havia pergunta em aberto do entrevistador/sugestão
    if (state.lastAsk?.text) {
      state.answeredQA.push({ q: state.lastAsk.text, a: answer });
      state.lastAsk = null;
      state.interviewing = false;
      setQuickReplies([]);
      await computeAndRender();
      return;
    }
  }

  // ---------- Header actions ----------
  $("#reset-btn")?.addEventListener("click", () => window.location.reload());
  $("#theme-toggle")?.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
  });

  // ---------- Boot ----------
  // ---------- Boot ----------
  greeting();
})();
});