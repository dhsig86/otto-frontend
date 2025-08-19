// app-ui.js
(function () {
  // --------------------------
  // Estado global simples
  // --------------------------
  const state = {
    consented: false,
    phase: "await_consent", // await_consent | await_chief | collecting | chatting
    payload: {
      domain: null, // inferido pelo robotto.js a partir do texto/sintomas
      age: null,
      sex: null,
      duration: null,
      symptoms: [],
      freeText: "",
      painScale: null,
      comorbidities: [],
      medications: [],
      red_flags_reported: []
    },
    rulesUrl: "./rules_otorrino.json"
  };

  // evita chamadas concorrentes ao backend
  let IN_FLIGHT = false;

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
    { key: "turvacao_visual", label: "Turvação visual súbita" },
    { key: "palpitacao", label: "Palpitação" },
    { key: "sensacao_de_desmaio", label: "Sensação de desmaio" },
    { key: "rigidez_de_pescoco", label: "Rigidez de pescoço" }
  ];

  // --------------------------
  // Utilidades UI
  // --------------------------
  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $("#messages");
  const progressEl = $("#progress");
  const quickEl = $("#quick-replies");

  function addMessage(role, html) {
    const wrap = document.createElement("div");
    const base = "max-w-[85%] rounded px-3 py-2 text-sm shadow";
    if (role === "user") {
      wrap.className = "flex justify-end";
      wrap.innerHTML = `<div class="${base} bg-blue-600 text-white">${html}</div>`;
    } else {
      wrap.className = "flex justify-start";
      wrap.innerHTML = `<div class="${base} bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">${html}</div>`;
    }
    messagesEl.appendChild(wrap);
    messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
  }

  function setProgress(v) { progressEl.value = v; }

  // Converte perguntas do motor em respostas-modelo editáveis
  function toAnswerTemplate(q) {
    const s = (q || "").toLowerCase();
    if (s.includes("quando os sintomas começaram") || s.includes("quando começou")) {
      return "Começaram há __ dias e desde então [pioraram/melhoraram/estão iguais].";
    }
    if (s.includes("piora") && s.includes("alivia")) {
      return "Piora com __ e alivia com __.";
    }
    if ((s.includes("febre") && (s.includes("secre") || s.includes("secreções"))) || s.includes("dor muito intensa")) {
      return "Sem febre, sem secreções; dor [leve/moderada/intensa].";
    }
    if (s.includes("exposição") && (s.includes("água") || s.includes("piscina"))) {
      return "Houve contato com água/piscina recentemente: [sim/não].";
    }
    return "Sobre isso: __";
  }

  function setQuickReplies(items = []) {
    quickEl.innerHTML = "";
    const src = (items && items.length) ? items.slice(0, 4) : [
      "Quando os sintomas começaram e como evoluíram desde então?",
      "Alguma coisa piora ou alivia os sintomas?",
      "Teve febre, secreções ou dor muito intensa?"
    ];
    src.forEach(txt => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rounded border px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700";
      const label = txt.replace(/^[•\-\d.\s]*/, "");
      const template = toAnswerTemplate(label);
      b.textContent = template;
      // Não envia automaticamente: preenche o input para o usuário editar/confirmar
      b.addEventListener("click", () => {
        const input = $("#user-input");
        input.value = template;
        input.focus();
      });
      quickEl.appendChild(b);
    });
  }

  function openOverlay(id) { const el = document.getElementById(id); el.style.display = "flex"; }
  function closeOverlay(id) { const el = document.getElementById(id); el.style.display = "none"; }

  function renderSymptoms() {
    const box = $("#symptom-options");
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
    $("#no-flags").checked = state.payload.red_flags_reported.length === 0;
  }

  function selectedSymptomLabels() {
    return SYMPTOMS_UI
      .filter(s => state.payload.symptoms.includes(s.key))
      .map(s => s.label);
  }

  // --------------------------
  // Integração com ROBOTTO
  // --------------------------
  async function computeAndRespond() {
    try {
      setProgress(0.2);

      let out;
      try {
        // 1ª tentativa: com regras
        out = await window.ROBOTTO.run(state.payload, { rulesUrl: state.rulesUrl, forceLLM: false });
      } catch (e) {
        console.warn("run com regras falhou; tentando sem rulesUrl:", e);
        // 2ª tentativa: sem regras (fallback)
        out = await window.ROBOTTO.run(state.payload, { forceLLM: false });
      }

      setProgress(0.9);
      renderBotFromResult(out);
      setProgress(1);
    } catch (e) {
      console.error(e);
      addMessage("bot", "Desculpe, ocorreu um erro ao processar. Tente novamente em instantes.");
      setProgress(0);
    }
  }

  function renderBotFromResult(out) {
    const { local, backend } = out || {};
    let html = "";

    const hasBackendFlags = Array.isArray(backend?.red_flags) && backend.red_flags.length > 0;
    if (hasBackendFlags) {
      html += `<p class="mb-2"><strong>⚠️ Sinais de alerta:</strong> ${backend.red_flags.join("; ")}</p>`;
    }

    if (backend && !(backend._error || backend.error) && Array.isArray(backend.differentials)) {
      html += `<p class="mb-1"><strong>Diferenciais prováveis:</strong></p><ul class="ml-4 list-disc">`;
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

    // Quick replies (em formato de resposta-modelo)
    if (local?.gaps?.questions?.length) setQuickReplies(local.gaps.questions);
    else setQuickReplies([]);

    addMessage("bot", html || "Ok! Pode me contar mais detalhes?");
  }

  async function sendUserMessage(text) {
    const msg = (text || $("#user-input").value || "").trim();
    if (!msg) return;

    $("#user-input").value = "";
    addMessage("user", msg);
    state.payload.freeText = (state.payload.freeText ? state.payload.freeText + " " : "") + msg;

    if (IN_FLIGHT) return;
    IN_FLIGHT = true;
    try {
      await computeAndRespond();
    } finally {
      IN_FLIGHT = false;
    }
  }

  // --------------------------
  // Controles (consentimento, tema, reset)
  // --------------------------
  $("#lgpd-checkbox").addEventListener("change", (e) => {
    $("#start-btn").disabled = !e.target.checked;
    $("#start-btn").classList.toggle("opacity-50", !e.target.checked);
  });

  $("#start-btn").addEventListener("click", () => {
    state.consented = true;
    state.phase = "await_chief";
    document.getElementById("consent").style.display = "none";
    addMessage("bot", "Olá! Eu sou o OTTO. Vou acolher e entender seu quadro para orientar com segurança. 😊");
    addMessage("bot", "Para começar: qual é a sua queixa principal? O que mais tem incomodado?");
    // O usuário pode abrir “Revisar sintomas” quando quiser.
  });

  $("#theme-toggle").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("otto_theme", document.body.classList.contains("dark") ? "dark" : "light");
  });

  (function initTheme() {
    const saved = localStorage.getItem("otto_theme");
    if (saved === "dark") document.body.classList.add("dark");
  })();

  $("#reset-btn").addEventListener("click", () => location.reload());

  // --------------------------
  // Overlays: sintomas
  // --------------------------
  $("#review-symptoms").addEventListener("click", () => {
    renderSymptoms();
    openOverlay("symptom-overlay");
  });

  $("#skip-symptoms").addEventListener("click", () => {
    closeOverlay("symptom-overlay");
    renderFlags();
    openOverlay("flag-overlay");
  });

  $("#symptom-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const sel = Array.from(document.querySelectorAll("#symptom-options input[type=checkbox]:checked"))
                     .map(i => i.value);
    state.payload.symptoms = sel;
    closeOverlay("symptom-overlay");
    renderFlags();
    openOverlay("flag-overlay");
  });

  // --------------------------
  // Overlays: red flags
  // --------------------------
  $("#flag-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#no-flags").checked) state.payload.red_flags_reported = [];
    else {
      const sel = Array.from(document.querySelectorAll("#flag-options input[type=checkbox]:checked"))
                       .map(i => i.value);
      state.payload.red_flags_reported = sel;
    }

    closeOverlay("flag-overlay");

    const labels = selectedSymptomLabels();
    if (labels.length) {
      addMessage("bot", "Entendi: " + labels.join(", ") + ".");
    }
    addMessage("bot", "Obrigado. Pode descrever quando começaram, se pioram à noite e se algo alivia?");

    if (IN_FLIGHT) return;
    IN_FLIGHT = true;
    try {
      await computeAndRespond();
    } finally {
      IN_FLIGHT = false;
    }
  });

  // --------------------------
  // Form de envio
  // --------------------------
  $("#input-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendUserMessage();
  });

  // Mensagem inicial (antes do consentimento)
  addMessage("bot", "Bem-vindo(a)! Para começar, confirme o consentimento LGPD.");
})();
// Fim do módulo app-ui.js
// ---------------- Fim do módulo app-ui.js ----------------