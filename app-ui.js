/* app-ui.js — OTTO (Tarefa 1: UX fluida + Orquestração)
   - Fluxo: Consentimento → Mini-intake (idade/sexo) → Prompt único (“escreva seus sintomas ou selecione”) → (opcional) seleção de sintomas → (opcional) red flags
   - Integração: agrega texto livre + sintomas + idade/sexo + features extraídas (duration/trajectory/febre) e envia ao ROBOTTO.run()
   - Evita perguntas duplicadas (ex.: febre), reduz “barulho” visual e mostra quick replies úteis.
   - Inclui novo sintoma: “rouquidao” (Rouco(a)/Sem voz).
*/

(() => {
  // --------------------------
  // Config de ambiente/UI
  // --------------------------
  const RULES_URL = "rules_otorrino.json"; // mantemos para compat
  const BACKEND_URL = (window.ROB_BACKEND_API_URL || "").replace(/\/+$/, "");
  const ALWAYS_CALL_BACKEND = true; // preferimos o backend sempre (ROBOTO também decide, mas aqui inclinamos)
  const MAX_DIFFS_SHOWN = 3;

  // Sintomas exibidos (labels em PT-BR, chaves usadas no engine)
  const SYMPTOMS_UI = [
    { key: "dor_de_garganta", label: "Dor de garganta" },
    { key: "sem_tosse", label: "Sem tosse" },
    { key: "tosse", label: "Tosse" },
    { key: "linfonodos_cervicais", label: "Ínguas/pescoço doloroso" },
    { key: "placas_amigdalas", label: "Placas/Exsudato nas amígdalas" },
    { key: "dor_de_ouvido", label: "Dor de ouvido" },
    { key: "otorreia", label: "Secreção no ouvido" },
    { key: "hipoacusia", label: "Perda de audição" },
    { key: "tinnitus", label: "Zumbido" },
    { key: "tontura", label: "Tontura/Vertigem" },
    { key: "nariz_entupido", label: "Nariz entupido" },
    { key: "coriza", label: "Coriza" },
    { key: "mau_cheiro", label: "Secreção com mau cheiro" },
    { key: "dor_de_cabeca", label: "Dor de cabeça" },
    { key: "rouquidao", label: "Rouco(a)/Sem voz" } // NOVO
  ];

  // Red flags que podemos perguntar UMA vez se o usuário aceitar
  const FLAGS_UI = [
    { key: "disfagia_importante", label: "Dificuldade importante para engolir" },
    { key: "sinais_respiratorios", label: "Dificuldade para respirar/estridor" },
    { key: "sangramento_persistente", label: "Sangramento persistente" },
    { key: "rigidez_pescoco", label: "Rigidez de pescoço" },
    { key: "febre_alta_persistente", label: "Febre alta persistente (>39 °C)" },
    { key: "sinais_neurologicos", label: "Sinais neurológicos (fraqueza, assimetria, confusão)" },
  ];

  // --------------------------
  // State principal
  // --------------------------
  const state = {
    rulesUrl: RULES_URL,
    backendUrl: BACKEND_URL,
    consented: false,
    askedFlagsOnce: false,      // só perguntar red flags uma vez por sessão
    flagsChecked: false,        // se o usuário já abriu o modal de flags
    lastShownFlagsHash: "",     // evitar repetição de mensagens de flags
    lastShownDiffKey: "",       // evitar repetição de blocos iguais
    payload: {
      // intake
      age: null,
      sex: null,               // "M" | "F" | "OUTRO"
      // sinais e contexto
      symptoms: [],
      red_flags_reported: [],
      comorbidities: [],
      medications: [],
      domain: null,            // inferido no ROBOTTO (opcional setar)
      // NL
      freeText: "",
      // extras parseados localmente
      extras: {
        parsed: {
          durationDays: null,
          trajectory: null,      // "piorando" | "melhorando" | "flutuante" ...
          feverMaxC: null        // número (Celsius)
        }
      }
    }
  };

  // --------------------------
  // Helpers de UI
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
      wrap.className = "flex justify-start";
      wrap.innerHTML = `<div class="${base} bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100">${html}</div>`;
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
            <span style="animation: blink 1.2s .2s infinite">.</span>
            <span style="animation: blink 1.2s .4s infinite">.</span>
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

  function setQuickReplies(items) {
    // items: [{text, onClick}] — evita flood/duplicações
    quickEl.innerHTML = "";
    (items || []).forEach((it) => {
      const b = document.createElement("button");
      b.className = "rounded-full border px-3 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800";
      b.textContent = it.text;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (typeof it.onClick === "function") it.onClick();
      });
      quickEl.appendChild(b);
    });
    quickEl.classList.toggle("hidden", quickEl.children.length === 0);
  }
  function hideQuickReplies() { setQuickReplies([]); }

  // --------------------------
  // Extração simples de NL
  // --------------------------
  function parseDurationDaysFromText(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    // dias
    let m = t.match(/(\d+)\s*(dia|dias|d)\b/);
    if (m) return parseInt(m[1], 10);
    // semanas
    m = t.match(/(\d+)\s*(semana|semanas|sem)\b/);
    if (m) return parseInt(m[1], 10) * 7;
    // meses → estimativa (30d)
    m = t.match(/(\d+)\s*(mes|mês|meses|m)\b/);
    if (m) return parseInt(m[1], 10) * 30;
    return null;
  }
  function parseTrajectoryFromText(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/\bpiora|piorando|agravando|agravou\b/.test(t)) return "piorando";
    if (/\bmelhor|melhorando|aliviando|aliviou\b/.test(t)) return "melhorando";
    if (/\boscil|flutu|vai e volta|epis[oó]d/i.test(t)) return "flutuante";
    return null;
  }
  function parseFeverMaxCFromText(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    // “38.5”, “38,5”, “38º”, “38 °C”
    const m = t.match(/(\d{2}(?:[.,]\d)?)\s*(?:°c|ºc|c\b|graus|º)?/i);
    if (m) {
      const n = parseFloat(String(m[1]).replace(",", "."));
      if (!isNaN(n) && n >= 35 && n <= 42) return n;
    }
    if (/\bfebr[ei]|calafrio|febr[ei]l\b/.test(t)) return 38.0; // heurística fraca
    return null;
  }

  // Constrói extras.parsed combinando texto livre atual
  function buildParsedExtras() {
    const ft = state.payload.freeText || "";
    const p = state.payload.extras?.parsed || {};
    const merged = {
      durationDays: p.durationDays ?? parseDurationDaysFromText(ft),
      trajectory: p.trajectory ?? parseTrajectoryFromText(ft),
      feverMaxC: p.feverMaxC ?? parseFeverMaxCFromText(ft),
    };
    state.payload.extras = { parsed: merged };
  }

  // --------------------------
  // UI: Overlays (sintomas/flags)
  // --------------------------
  function openOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
  }
  function closeOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add("hidden");
    el.classList.remove("flex");
  }

  function renderSymptomsChecklist() {
    const box = $("#symptom-options");
    if (!box) return;
    box.innerHTML = "";
    SYMPTOMS_UI.forEach((s) => {
      const id = `sx_${s.key}`;
      const wrap = document.createElement("label");
      wrap.className = "flex items-center gap-2";
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" value="${s.key}" />
        <span>${s.label}</span>`;
      box.appendChild(wrap);
    });
  }

  function renderFlagsChecklist() {
    const box = $("#flag-options");
    if (!box) return;
    box.innerHTML = "";
    FLAGS_UI.forEach((f) => {
      const id = `rf_${f.key}`;
      const wrap = document.createElement("label");
      wrap.className = "flex items-center gap-2";
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" value="${f.key}" />
        <span>${f.label}</span>`;
      box.appendChild(wrap);
    });
  }

  function getSelectedValues(containerSel) {
    const cont = $(containerSel);
    if (!cont) return [];
    const vals = [];
    cont.querySelectorAll("input[type=checkbox]").forEach((inp) => {
      if (inp.checked) vals.push(inp.value);
    });
    return vals;
  }

  // --------------------------
  // Integração com ROBOTTO
  // --------------------------
  async function computeAndRespond({ force = false } = {}) {
    try {
      hideQuickReplies();

      // Só roda se houver algo para processar (texto ou sintomas) OU forçado
      const hasAnyInfo =
        (state.payload.freeText && state.payload.freeText.trim().length > 0) ||
        (state.payload.symptoms && state.payload.symptoms.length > 0) ||
        force;

      if (!hasAnyInfo) {
        suggestStart();
        return;
      }

      buildParsedExtras(); // garante extras.parsed

      // Configurar orchestrator para “balanced” (sempre que possível)
      try {
        if (window.ROBOTTO && typeof window.ROBOTTO.setConfig === "function") {
          window.ROBOTTO.setConfig({
            CALL_LLM_POLICY: ALWAYS_CALL_BACKEND ? "balanced" : "smart",
            LOCAL_CONF_THRESHOLD: 0.72,
            HYBRID_BACKEND_WEIGHT: 0.6,
            BACKEND_API_URL: state.backendUrl || undefined
          });
        }
      } catch (e) {
        console.warn("setConfig falhou (segue padrão do robotto.js):", e);
      }

      showTyping();
      let out;
      try {
        out = await window.ROBOTTO.run(state.payload, {
          rulesUrl: state.rulesUrl,
          forceLLM: ALWAYS_CALL_BACKEND ? false : false // mantemos decisão interna, mas política já setada
        });
      } catch (e) {
        console.warn("run com rules falhou; tentando sem rules:", e);
        out = await window.ROBOTTO.run(state.payload, { forceLLM: false });
      }
      hideTyping();

      renderFromResult(out);
      ensureQuickReplies(out);

    } catch (err) {
      hideTyping();
      console.error("computeAndRespond error:", err);
      addMessage("bot", "Houve um problema técnico. Tente novamente em instantes.");
    }
  }

  function compactDiffList(list) {
    if (!Array.isArray(list)) return [];
    // normaliza para {dx, probability, rationale?}
    return list
      .filter(Boolean)
      .map((x) => ({
        dx: String(x.dx || x.name || x.label || "").trim(),
        probability: typeof x.probability === "number" ? x.probability :
          (typeof x.prob === "number" ? x.prob : null),
        rationale: x.rationale || x.explain || x.whyFor?.join("; ")
      }))
      .filter((x) => x.dx);
  }

  function formatDiffBlock(list) {
    const top = compactDiffList(list).slice(0, MAX_DIFFS_SHOWN);
    if (!top.length) return "";
    const lines = top.map((d, i) => {
      const pct = d.probability != null ? Math.round(d.probability * 100) : null;
      return `• ${d.dx}${pct != null ? ` (${pct}%)` : ""}`;
    });
    return lines.join("<br/>");
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  function renderFromResult(out) {
    // Seleção do “final” e saneamento
    const finalList =
      out?.final?.differentials ||
      out?.backend?.differentials ||
      out?.local?.list ||
      [];

    const diffBlock = formatDiffBlock(finalList);
    const care = out?.final?.care_level || out?.backend?.care_level || out?.care_level || null;

    // Evita repetir o mesmo bloco se nada mudou
    const key = hashStr(JSON.stringify({
      d: finalList.map((x) => [x.dx, x.probability]),
      care
    }));
    if (key && key === state.lastShownDiffKey) {
      // não repete — ainda assim podemos atualizar sugestões/flags
    } else {
      state.lastShownDiffKey = key;
      // Mensagem enxuta: diferenciais + próximos passos (se houver)
      let html = "";
      if (diffBlock) {
        html += `<div class="font-semibold mb-1">Hipóteses principais</div>${diffBlock}`;
      }
      const nexts = out?.final?.next_steps || out?.backend?.next_steps || [];
      if (nexts.length) {
        const uniq = [...new Set(nexts.map((s) => String(s).trim()).filter(Boolean))].slice(0, 4);
        if (uniq.length) {
          html += `<div class="mt-2 font-semibold">Próximos passos</div><div class="text-sm">${uniq.map(s => `• ${s}`).join("<br/>")}</div>`;
        }
      }
      if (!html) html = "Vamos continuar. Conte-me mais sobre seus sintomas (ou abra a caixa para selecionar).";

      addMessage("bot", html);
    }

    // Flags do backend (não repetir “nenhum” e não duplicar)
    const flags = Array.from(new Set([...(out?.final?.red_flags || out?.backend?.red_flags || [])]));
    const flagsHash = hashStr(flags.join("|"));
    if (flags.length && flagsHash !== state.lastShownFlagsHash) {
      state.lastShownFlagsHash = flagsHash;
      addMessage("bot", `<span class="font-semibold">Sinais de alerta mencionados pelo motor:</span><br/>${flags.map(f => `• ${f}`).join("<br/>")}`);
    }
  }

  function ensureQuickReplies(out) {
    const items = [];

    // 1) Ações de UI úteis
    items.push({
      text: "➕ Adicionar sintomas",
      onClick: () => {
        openOverlay("symptom-overlay");
      }
    });

    if (!state.askedFlagsOnce) {
      items.push({
        text: "🚩 Checar sinais de alerta",
        onClick: () => {
          state.askedFlagsOnce = true;
          openOverlay("flag-overlay");
        }
      });
    }

    // 2) Sugestões do backend (deduplicadas e curtas)
    const qs = (out?.backend?.query_suggestions?.questions || []).map(q => String(q).trim()).filter(Boolean);
    const seen = new Set();
    qs.forEach((q) => {
      const norm = q.toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[?!.]+$/g, "");
      // filtrar perguntas sobre febre se já extraímos febre do texto
      if (/febre|temperatura|graus/.test(norm)) {
        if (state.payload.extras?.parsed?.feverMaxC != null) return; // já temos
      }
      if (seen.has(norm)) return;
      seen.add(norm);
      items.push({
        text: q.length > 48 ? q.slice(0, 46) + "…" : q,
        onClick: () => {
          // Deixa o usuário responder livremente no input (experiência mais natural)
          addMessage("bot", q);
          inputEl.focus();
        }
      });
    });

    // 3) Gerar relatório
    items.push({
      text: "📝 Gerar relatório",
      onClick: () => handleExport()
    });

    setQuickReplies(items);
  }

  // --------------------------
  // Relatório (HTML simples → impressão/PDF do navegador)
  // --------------------------
  function handleExport() {
    try {
      const last = (window.ROBOTTO && window.ROBOTTO.last && window.ROBOTTO.last()) || null;
      const out = last || {};
      const diffs = compactDiffList(out?.final?.differentials || out?.backend?.differentials || out?.local?.list || []);
      const care = out?.final?.care_level || out?.backend?.care_level || "routine";
      const flags = Array.from(new Set(out?.final?.red_flags || out?.backend?.red_flags || []));
      const steps = out?.final?.next_steps || out?.backend?.next_steps || [];

      let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;max-width:800px;margin:0 auto">
        <h1 style="margin:0 0 8px">Relatório de Triagem – OTTO</h1>
        <div style="font-size:12px;color:#666;margin-bottom:16px">Este relatório é educativo e não substitui avaliação médica presencial.</div>
        <hr/>
        <h3>Dados informados</h3>
        <ul>
          <li><b>Idade/Sexo:</b> ${state.payload.age ?? "–"} / ${state.payload.sex ?? "–"}</li>
          <li><b>Sintomas selecionados:</b> ${state.payload.symptoms.length ? state.payload.symptoms.join(", ") : "–"}</li>
          <li><b>Texto livre:</b> ${state.payload.freeText ? state.payload.freeText : "–"}</li>
          <li><b>Red flags reportadas:</b> ${state.payload.red_flags_reported.length ? state.payload.red_flags_reported.join(", ") : "–"}</li>
          <li><b>Duração/Trajetória/Febre máx. (parseadas):</b> ${[
            state.payload.extras?.parsed?.durationDays != null ? `${state.payload.extras.parsed.durationDays}d` : "–",
            state.payload.extras?.parsed?.trajectory || "–",
            state.payload.extras?.parsed?.feverMaxC != null ? `${state.payload.extras.parsed.feverMaxC} °C` : "–"
          ].join(" / ")}</li>
        </ul>
        <h3>Hipóteses principais</h3>
        <ol>${diffs.map(d => `<li>${d.dx}${d.probability != null ? ` (${Math.round(d.probability*100)}%)` : ""}</li>`).join("") || "<li>–</li>"}</ol>
        <h3>Nível de cuidado</h3>
        <p>${care}</p>
        ${flags.length ? `<h3>Sinais de alerta</h3><ul>${flags.map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
        ${steps.length ? `<h3>Próximos passos</h3><ul>${steps.slice(0,6).map(s => `<li>${s}</li>`).join("")}</ul>` : ""}
        ${out?.final?.references?.length ? `<h3>Referências</h3><ul style="font-size:12px;color:#555">${out.final.references.map(r => `<li>${r}</li>`).join("")}</ul>` : ""}
        <hr/>
        <div style="font-size:11px;color:#777">Gerado automaticamente por OTTO – Triagem ORL (educacional).</div>
      </div>`;
      const w = window.open("", "_blank");
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Relatório de Triagem</title></head><body>${html}</body></html>`);
      w.document.close();
      w.focus();
      w.print();
    } catch (e) {
      console.error("export error:", e);
      addMessage("bot", "Não consegui gerar o relatório agora. Tente novamente.");
    }
  }

  // --------------------------
  // Início orientado
  // --------------------------
  function suggestStart() {
    const msg = `Pode <b>escrever em linguagem natural</b> o que está sentindo, e/ou <b>abrir a seleção de sintomas</b> (botão abaixo). O motor combinará suas respostas de forma inteligente.`;
    addMessage("bot", msg);
    setQuickReplies([
      { text: "➕ Selecionar sintomas", onClick: () => openOverlay("symptom-overlay") }
    ]);
  }

  // --------------------------
  // Eventos: consentimento / mini-intake / sintomas / flags / chat
  // --------------------------

  // Consentimento
  const consentEl = $("#consent");
  const consentChk = $("#lgpd-checkbox");
  const startBtn = $("#start-btn");
  if (consentChk && startBtn) {
    consentChk.addEventListener("change", () => {
      startBtn.disabled = !consentChk.checked;
      startBtn.classList.toggle("opacity-50", startBtn.disabled);
    });
    startBtn.addEventListener("click", (e) => {
      e.preventDefault();
      state.consented = true;
      if (consentEl) consentEl.classList.add("hidden");
      // abrir mini-intake
      const mini = $("#mini-intake");
      if (mini) { mini.classList.remove("hidden"); mini.classList.add("flex"); }
    });
  }

  // Mini-intake (idade/sexo)
  const miniForm = $("#mini-intake-form");
  if (miniForm) {
    miniForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const age = parseInt($("#mini-age").value, 10);
      const sex = (document.querySelector("#mini-intake-form select")?.value || "").toUpperCase();
      if (!Number.isFinite(age) || age < 0) {
        addMessage("bot", "Idade inválida. Corrija e envie novamente.");
        return;
      }
      state.payload.age = age;
      state.payload.sex = sex || null;
      closeOverlay("mini-intake");
      addMessage("bot", "Obrigado. Agora, descreva seus sintomas em uma frase (ex.: “dor de garganta há 5 dias, piorando, sem tosse”) ou abra a caixa para selecionar itens.");
      setQuickReplies([
        { text: "➕ Selecionar sintomas", onClick: () => openOverlay("symptom-overlay") }
      ]);
    });
  }

  // Checklist de sintomas
  renderSymptomsChecklist();
  const sxForm = $("#symptom-form");
  const sxSkip = $("#skip-symptoms");
  if (sxForm) {
    sxForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const sel = getSelectedValues("#symptom-options");
      state.payload.symptoms = Array.from(new Set([...(state.payload.symptoms || []), ...sel]));
      closeOverlay("symptom-overlay");

      if (sel.length) {
        addMessage("user", `Adicionei: ${sel.join(", ")}`);
      }
      await computeAndRespond({ force: true });
    });
  }
  if (sxSkip) {
    sxSkip.addEventListener("click", (e) => {
      e.preventDefault();
      closeOverlay("symptom-overlay");
      // não força cálculo aqui: usuário pode preferir escrever primeiro
      addMessage("bot", "Certo. Se preferir, descreva em texto o que está sentindo e seguirei com a análise.");
    });
  }

  // Flags (uma vez, se o usuário quiser)
  renderFlagsChecklist();
  const flagForm = $("#flag-form");
  const noFlagsBtn = $("#no-flags");
  if (flagForm) {
    flagForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const sel = getSelectedValues("#flag-options");
      state.payload.red_flags_reported = Array.from(new Set([...(state.payload.red_flags_reported || []), ...sel]));
      closeOverlay("flag-overlay");
      if (sel.length) addMessage("user", `Sinais de alerta presentes: ${sel.join(", ")}`);
      await computeAndRespond({ force: true });
    });
  }
  if (noFlagsBtn) {
    noFlagsBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      state.payload.red_flags_reported = state.payload.red_flags_reported || [];
      closeOverlay("flag-overlay");
      addMessage("user", "Sem sinais de alerta.");
      await computeAndRespond({ force: true });
    });
  }

  // Chat: entrada livre
  const form = $("#input-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = (inputEl.value || "").trim();
      if (!msg) return;
      inputEl.value = "";
      addMessage("user", msg);
      // agrega ao freeText
      state.payload.freeText = (state.payload.freeText ? state.payload.freeText + " " : "") + msg;
      await computeAndRespond();
    });
  }

  // Botão “Revisar sintomas” (abre modal)
  const reviewBtn = $("#review-symptoms");
  if (reviewBtn) {
    reviewBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openOverlay("symptom-overlay");
    });
  }

  // Ao carregar, definir configuração de orquestração padrão (caso o robotto.js já tenha inicializado)
  window.addEventListener("load", () => {
    try {
      if (window.ROBOTTO && typeof window.ROBOTTO.setConfig === "function") {
        window.ROBOTTO.setConfig({
          BACKEND_API_URL: state.backendUrl || undefined,
          CALL_LLM_POLICY: ALWAYS_CALL_BACKEND ? "balanced" : "smart",
          LOCAL_CONF_THRESHOLD: 0.72,
          HYBRID_BACKEND_WEIGHT: 0.6
        });
      }
    } catch (e) {
      console.warn("setConfig on load falhou:", e);
    }
  });

  // Reset rápido (se existir botão no header)
  const resetBtn = $("#reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      // limpa chat e state parcial (mantém consentimento)
      messagesEl.innerHTML = "";
      hideQuickReplies();
      state.askedFlagsOnce = false;
      state.flagsChecked = false;
      state.lastShownFlagsHash = "";
      state.lastShownDiffKey = "";
      state.payload.symptoms = [];
      state.payload.red_flags_reported = [];
      state.payload.freeText = "";
      state.payload.extras = { parsed: { durationDays: null, trajectory: null, feverMaxC: null } };
      addMessage("bot", "Reiniciado. Descreva seus sintomas ou abra a seleção para escolher itens.");
      setQuickReplies([
        { text: "➕ Selecionar sintomas", onClick: () => openOverlay("symptom-overlay") }
      ]);
    });
  }

  // Tema (se existir #theme-toggle)
  const themeBtn = $("#theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      document.documentElement.classList.toggle("dark");
    });
  }

  // Mensagem de boas-vindas inicial (sem disparar cálculo)
  addMessage("bot", "Olá! Eu sou o OTTO 👋. Antes de começar, confirme o consentimento e informe idade/sexo. Depois, você pode escrever seus sintomas em uma frase e/ou abrir a caixa de seleção para adicionar sintomas.");
  setQuickReplies([]); // aguardando consentimento/mini-intake
})();
