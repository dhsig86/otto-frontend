// app-ui.js (UX refinado)
// - Quick replies = sugestões que preenchem o input (não enviam).
// - “Selecionar sintomas”, typing indicator, relatório PDF.
// - Chama ROBOTTO.run com fallback se as rules não carregarem.

(function () {
  // --------------------------
  // Estado global simples
  // --------------------------
  const state = {
    consented: false,
    askedSymptomsOnce: false, // abre overlay de sintomas após 1ª msg livre
    payload: {
      domain: null,
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
  const progressEl = $("#progress"); // vamos esconder e usar typing
  const quickEl = $("#quick-replies");
  const inputEl = $("#user-input");

  // Esconder a barra de progresso (vamos usar “digitando...”)
  if (progressEl) progressEl.style.display = "none";

  // Criar botão de relatório (aparece após 1ª resposta)
  let exportBtn = null;
  function ensureExportBtn() {
    if (exportBtn) return exportBtn;
    exportBtn = document.createElement("button");
    exportBtn.id = "export-report";
    exportBtn.type = "button";
    exportBtn.textContent = "Gerar relatório (PDF)";
    exportBtn.className = "mb-2 hidden rounded bg-green-600 px-3 py-1 text-white";
    const footer = document.querySelector("footer");
    footer.insertBefore(exportBtn, quickEl);
    exportBtn.addEventListener("click", handleExportPDF);
    return exportBtn;
  }

  // Indicador “digitando…”
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


  function setQuickReplies(items = []) {
    quickEl.innerHTML = "";
    const suggestions = items.length ? items : [
      "Começaram há __ dias e desde então [pioraram/melhoraram/estão iguais].",
      "Piora com __ e alivia com __.",
      "Sem febre, sem secreções; dor [leve/moderada/intensa]."
    ];
    // container compacto e rolável em linha
    quickEl.className = "mb-2 flex gap-2 overflow-x-auto whitespace-nowrap";
    suggestions.slice(0, 3).forEach(txt => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "shrink-0 rounded-full border border-sky-200/60 bg-white px-3 py-1 text-xs text-sky-700 hover:bg-sky-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100";
      b.textContent = txt.replace(/^[•\-\d.\s]*/, "");
      // Preenche o input (não envia)
      b.addEventListener("click", () => {
        inputEl.value = (inputEl.value ? (inputEl.value.trim() + " ") : "") + b.textContent;
        inputEl.focus();
      });
      quickEl.appendChild(b);
    });
    quickEl.style.display = "flex";
  }
  function hideQuickReplies() {
    quickEl.innerHTML = "";
    quickEl.style.display = "none";
  }

  function openOverlay(id) { const el = document.getElementById(id); el.classList.remove("hidden"); el.classList.add("flex"); }
  function closeOverlay(id) { const el = document.getElementById(id); el.classList.add("hidden"); el.classList.remove("flex"); }

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
        console.warn("run com regras falhou; tentando sem rulesUrl:", e);
        out = await window.ROBOTTO.run(state.payload, { forceLLM: false });
      }

      hideTyping();
      renderBotFromResult(out);

      // Habilita botão de relatório
      ensureExportBtn().classList.remove("hidden");

      // Se ainda não coletamos sintomas e usuário já conversou, abre overlay
      if (!state.askedSymptomsOnce && (!state.payload.symptoms || state.payload.symptoms.length === 0)) {
        state.askedSymptomsOnce = true;
        renderSymptoms();
        openOverlay("symptom-overlay");
      }
    } catch (e) {
      hideTyping();
      console.error(e);
      addMessage("bot", "Desculpe, ocorreu um erro ao processar. Tente novamente em instantes.");
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

    // Quick replies enxutas (só quando ajudam)
    const suggestions = [];
    if (!state.payload.duration) suggestions.push("Começaram há __ dias e desde então [pioraram/melhoraram/estão iguais].");
    if (!/piora|alivia/i.test(state.payload.freeText)) suggestions.push("Piora com __ e alivia com __.");
    if (!state.payload.symptoms.includes("febre") && !/febre/i.test(state.payload.freeText)) suggestions.push("Sem febre, sem secreções; dor [leve/moderada/intensa].");
    if (suggestions.length) setQuickReplies(suggestions); else hideQuickReplies();

    addMessage("bot", html || "Ok! Pode me contar mais detalhes?");
  }

  async function sendUserMessage(text) {
    const msg = (text || inputEl.value || "").trim();
    if (!msg) return;
    inputEl.value = "";
    addMessage("user", msg);
    state.payload.freeText = (state.payload.freeText ? state.payload.freeText + " " : "") + msg;
    await computeAndRespond();
  }

  // --------------------------
  // Relatório (PDF/print)
  // --------------------------
  function handleExportPDF() {
    try {
      const last = (window.ROBOTTO && window.ROBOTTO.last && window.ROBOTTO.last()) || null;
      const backend = last?.backend;
      const local = last?.local;

      let body = `<h1 style="font:600 18px system-ui;margin:0 0 8px">Relatório de Triagem – OTTO</h1>`;
      body += `<p style="margin:0 0 12px">Gerado em ${new Date().toLocaleString()}</p>`;

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

      // abre janela pronta para imprimir/salvar em PDF
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
  // Controles (consentimento, tema, reset)
  // --------------------------
  $("#lgpd-checkbox").addEventListener("change", (e) => {
    $("#start-btn").disabled = !e.target.checked;
    $("#start-btn").classList.toggle("opacity-50", !e.target.checked);
  });

  $("#start-btn").addEventListener("click", () => {
    state.consented = true;
    document.getElementById("consent").classList.add("hidden");
    addMessage("bot", "Olá! Eu sou o OTTO. Vou acolher e entender seu quadro para orientar com segurança. 😊");
    addMessage("bot", "Para começar: qual é a sua queixa principal? O que mais tem incomodado?");
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
  // Renomeia botão para “Selecionar sintomas”
  const reviewBtn = $("#review-symptoms");
  if (reviewBtn) reviewBtn.textContent = "Selecionar sintomas";

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
  $("#flag-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("#no-flags").checked) state.payload.red_flags_reported = [];
    else {
      const sel = Array.from(document.querySelectorAll("#flag-options input[type=checkbox]:checked"))
                       .map(i => i.value);
      state.payload.red_flags_reported = sel;
    }
    closeOverlay("flag-overlay");
    addMessage("bot", "Obrigado. Vamos trabalhar juntos nessa. Conte-me mais detalhes sobre seus sintomas ou adicione sintomas na caixa de seleção.");
    computeAndRespond();
  });

  // Esconde o splash depois que a UI estiver pronta (ou após X ms)
window.addEventListener("load", () => {
  const s = document.getElementById("splash-otto");
  if (!s) return;
  setTimeout(() => s.classList.add("fade-out"), 900); // ~1s
});


  // --------------------------
  // Form de envio
  // --------------------------
  $("#input-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendUserMessage();
  });

  // Mensagem inicial (antes do consentimento)
  addMessage("bot", "Bem-vindo(a)! Para começar, confirme o consentimento LGPD.");
})();
