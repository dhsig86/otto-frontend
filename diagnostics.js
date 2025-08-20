// diagnostics.js — Motor local de diferenciais (v4.2)
// - Usa rules_otorrino.json (priors, symptom_weights, modifiers).
// - Exporta window.localDifferentials(payload, rules).
// - Gera gaps (perguntas) sem duplicar "febre" se já houver febre em sintomas OU negações.
// - Compatível com app-ui.js v5 e robotto.js v3.3.0.

(function () {
  // ===============================
  // Utilidades básicas
  // ===============================
  const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : a));
  const toNum = (x, d = 0) => (x == null || isNaN(+x) ? d : +x);
  const norm = (s) => (s || "").toLowerCase().trim();

  // ===============================
  // Mapa de capítulos (referências resumidas)
  // ===============================
  const DX_TO_ENT_BOOK = {
    "Otite Externa Aguda": ["CURRENT Oto-HNS 3e — External Ear"],
    "Otite Média Aguda": ["CURRENT Oto-HNS 3e — Otitis Media"],
    "Tampão de cerume": ["CURRENT Oto-HNS 3e — External Ear (Cerumen)"],
    "Rinossinusite viral": ["CURRENT Oto-HNS 3e — Acute & Chronic Sinusitis"],
    "Rinossinusite bacteriana": ["CURRENT Oto-HNS 3e — Acute & Chronic Sinusitis"],
    "Rinite alérgica": ["CURRENT Oto-HNS 3e — Rhinitis"],
    "Faringoamigdalite viral": ["CURRENT Oto-HNS 3e — Oropharynx & Tonsil"],
    "Amigdalite estreptocócica": ["CURRENT Oto-HNS 3e — Oropharynx & Tonsil"],
    "DRGE/LPR": ["CURRENT Oto-HNS 3e — Larynx/Hypopharynx & Oropharynx"],
    "Linfadenite reacional": ["CURRENT Oto-HNS 3e — Neck Masses"],
    "Sialadenite/sialolitíase": ["CURRENT Oto-HNS 3e — Salivary Glands"]
  };

  // ===============================
  // Normalização de duração para dias
  // ===============================
  function parseDurationDays(payload) {
    if (payload?.extras?.parsed?.durationDays != null) return payload.extras.parsed.durationDays;
    const d = String(payload?.duration || payload?.duration_norm || "").toLowerCase();

    let m = d.match(/^p(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?$/i);
    if (m) {
      const months = m[1] ? +m[1] : 0;
      const weeks  = m[2] ? +m[2] : 0;
      const days   = m[3] ? +m[3] : 0;
      return months * 30 + weeks * 7 + days;
    }
    m = d.match(/^pt(\d+)h$/i);
    if (m) return Math.max(0.04, (+m[1]) / 24);

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

  // ===============================
  // Mapeamento de sintomas UI → regras
  // ===============================
  function buildReverseAliases(rules) {
    const rev = {};
    const aliases = rules?.logic?.symptom_aliases || {};
    for (const key of Object.keys(aliases)) {
      const arr = aliases[key] || [];
      rev[key] = key;
      arr.forEach(a => rev[a] = key);
    }
    return rev;
  }

  function normalizeSymptoms(uiSymptoms, revAliases) {
    const set = new Set();
    (uiSymptoms || []).forEach(k => {
      const std = revAliases[k] || k;
      set.add(std);
      if (std === "coriza") set.add("rinorreia");
      if (std === "nariz_entupido") set.add("obstrucao_nasal");
      if (std === "dor_de_garganta") set.add("odinofagia");
      if (std === "dor_de_ouvido") set.add("otalgia");
      if (std === "secrecao_otica") set.add("otorreia");
      if (std === "reducao_olfato") set.add("hiposmia");
      if (std === "dificuldade_de_ouvir") set.add("hipoacusia");
      if (std === "pressao_na_face") set.add("pressao_facial");
      if (std === "mau_cheiro") set.add("cacosmia");
    });
    return set;
  }

  // ===============================
  // Cálculo — score simples + normalização
  // ===============================
  function computeDxScores(payload, rules) {
    const domain = payload?.domain || inferDomainFromText(payload?.freeText || payload?.freeTextOriginal || "") || "garganta";
    const block = rules?.domains?.[domain];
    if (!block || !Array.isArray(block.dx)) return [];

    const revAliases = buildReverseAliases(rules);
    const sxSet = normalizeSymptoms(payload?.symptoms || [], revAliases);
    const durationDays = parseDurationDays(payload);
    const age = toNum(payload?.age, null);
    const tmax = toNum(payload?.fever_max_c, null);
    const traj = payload?.trajectory || null;
    const negs = new Set((payload?.negations || []).map(norm));

    const K = 0.25; // fator de escala para symptom_weights
    const out = [];

    block.dx.forEach(d => {
      const prior = clamp(toNum(d.prior, 0.2), 0.01, 0.95);
      let score = prior;

      // sintomas
      const sw = d.symptom_weights || {};
      for (const key of Object.keys(sw)) {
        if (sxSet.has(key)) score += K * toNum(sw[key], 0);
      }

      // modifiers
      const md = d.modifiers || {};
      if (Array.isArray(md.age) && age != null) {
        md.age.forEach(rule => {
          const gteOk = (rule.gte == null) || (age >= rule.gte);
          const lteOk = (rule.lte == null) || (age <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (Array.isArray(md.duration_days) && durationDays != null) {
        md.duration_days.forEach(rule => {
          const gteOk = (rule.gte == null) || (durationDays >= rule.gte);
          const lteOk = (rule.lte == null) || (durationDays <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (Array.isArray(md.trajectory) && traj) {
        md.trajectory.forEach(rule => {
          const match = String(rule.is || "").toLowerCase() === String(traj).toLowerCase();
          const minD = toNum(rule.min_duration_days, null);
          if (match && (minD == null || (durationDays != null && durationDays >= minD))) score += toNum(rule.boost, 0);
        });
      }
      if (Array.isArray(md.fever_max_c) && tmax != null) {
        md.fever_max_c.forEach(rule => {
          const gteOk = (rule.gte == null) || (tmax >= rule.gte);
          const lteOk = (rule.lte == null) || (tmax <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (md.negations && typeof md.negations === "object") {
        for (const negKey of Object.keys(md.negations)) {
          const boost = toNum(md.negations[negKey], 0);
          if (negs.has(negKey) || negs.has(`sem_${negKey}`)) score += boost;
        }
      }

      score = clamp(score, 0.001, 0.999);
      out.push({ dx: d.name, score, source: d.source || null });
    });

    const sum = out.reduce((a, b) => a + b.score, 0) || 1;
    out.forEach(o => { o.probability = clamp(o.score / sum, 0, 1); });
    out.sort((a, b) => b.probability - a.probability);
    return out;
  }

  // ===============================
  // Gaps / follow-ups (SIM/NÃO)
  // ===============================
  function buildGaps(payload) {
    const qs = [];
    const sxSet = new Set((payload?.symptoms || []).map(norm));
    const negs = new Set((payload?.negations || []).map(norm));

    // genéricas (evita perguntar febre 2x)
    if (!payload?.duration && !payload?.duration_norm) qs.push("Há quantos dias os sintomas começaram?");
    if (!payload?.trajectory) qs.push("Desde o início, os sintomas estão piorando?");
    const hasFebre = sxSet.has("febre") || negs.has("febre") || /afebril/.test(String(payload?.freeTextOriginal || "")); 
    if (payload?.fever_max_c == null && !hasFebre) qs.push("Você teve febre?");
    
    // domínio-específicas
    const dom = payload?.domain;
    if (dom === "nariz") {
      if (!/dupla_piora/i.test(String(payload?.trajectory || ""))) qs.push("Houve 'dupla piora' após alguma melhora?");
    }
    if (dom === "garganta") {
      qs.push("Você tem placas ou exsudato nas amígdalas?");
      if (!(negs.has("tosse") || /sem\s+tosse/i.test(String(payload?.freeTextOriginal || ""))))
        qs.push("Você tem tosse?");
    }
    if (dom === "ouvido") {
      qs.push("Tocar/puxar o pavilhão auricular aumenta a dor?");
      qs.push("Sai secreção pelo ouvido?");
    }
    return { questions: dedup(qs).slice(0, 3) };
  }

  function dedup(arr) {
    const s = new Set();
    const out = [];
    (arr || []).forEach(x => { if (!s.has(x)) { s.add(x); out.push(x); } });
    return out;
  }

  // ===============================
  // Inferência de domínio (fallback)
  // ===============================
  function inferDomainFromText(t) {
    const s = (t || "").toLowerCase();
    if (/ouvid|otalg|otite|timp|orelha/.test(s)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus|epistax/.test(s)) return "nariz";
    if (/gargant|faring|larin|amigdal|odinofag/.test(s)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(s)) return "pescoco";
    return "garganta";
  }

  // ===============================
  // Confiança (heurística simples)
  // ===============================
  function estimateConfidence(list, payload) {
    if (!list || !list.length) return 0.5;
    const top = list[0]?.probability || 0;
    const second = list[1]?.probability || 0;
    const sep = Math.max(0, top - second);
    let signals = 0;
    if (payload?.symptoms?.length) signals += Math.min(3, payload.symptoms.length);
    if (payload?.fever_max_c != null) signals += 1;
    if (payload?.trajectory) signals += 1;
    if (payload?.duration || payload?.duration_norm) signals += 1;
    const base = 0.45 + 0.08 * signals + 0.25 * sep;
    return clamp(base, 0.3, 0.95);
  }

  // ===============================
  // Função principal
  // ===============================
  function localDifferentials(payload, rules) {
    const r = rules || {};
    const list = computeDxScores(payload || {}, r);
    const top3 = list.slice(0, 3).map(d => ({ dx: d.dx, probability: d.probability }));
    const confidence = estimateConfidence(list, payload);
    const gaps = buildGaps(payload);

    // Referências
    const refsFromRules = [];
    const domain = payload?.domain || inferDomainFromText(payload?.freeText || payload?.freeTextOriginal || "");
    const dxBlock = r?.domains?.[domain]?.dx || [];
    const nameToSource = {};
    dxBlock.forEach(x => { nameToSource[String(x.name)] = x.source || null; });
    list.forEach(d => { const src = nameToSource[d.dx]; if (src) refsFromRules.push(String(src)); });

    const refsFromBook = [];
    list.forEach(d => { if (DX_TO_ENT_BOOK[d.dx]) refsFromBook.push(...DX_TO_ENT_BOOK[d.dx]); });

    const references = dedup([...refsFromRules, ...refsFromBook]);

    return { list, top3, confidence, gaps, references };
  }

  window.localDifferentials = localDifferentials;
})();
