/* diagnostics.js (v4, 2025-08-19)
   Motor local de diferenciais para OUVIDO / NARIZ / GARGANTA / PESCOCO.

   Principais correções/melhorias vs v3:
   - Mapeamento robusto das KEYS da UI → features internas (acabou o “não reagir” ao checklist).
   - Integra parser clínico (duração/trajectória/febre máx./negações).
   - Suporte OPCIONAL a weights/modifiers do rules_otorrino.json (se existir).
   - Correções de vazamento e normalização de probabilidades.
   - API compatível: localDifferentials(payload, rules) → { list, confidence, gaps, redFlags, references }
*/

(function (global) {
  // --------------- Utils ---------------
  const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0));
  const norm = (s) => (s || "").toLowerCase().trim();

  const NUM = {
    toFloat(s) {
      if (s == null) return null;
      const t = String(s).replace(",", ".").replace(/[^\d.]/g, "");
      const v = parseFloat(t);
      return Number.isFinite(v) ? v : null;
    },
    daysFrom(s) {
      if (!s) return null;
      const t = norm(s);
      // "há 5 dias" | "5 dias" | "5d" | "48h" | "2 semanas" | "3 meses"
      const m = t.match(/\b(?:ha|há)?\s*(\d+[.,]?\d*)\s*(horas?|h|dias?|d|semanas?|sem|mes(?:es)?|m)\b/);
      if (!m) return null;
      const n = this.toFloat(m[1]);
      const u = m[2];
      if (!Number.isFinite(n)) return null;
      if (/^h|hora/.test(u)) return Math.max(0.04, n / 24);
      if (/^d|dia/.test(u)) return n;
      if (/^sem/.test(u)) return n * 7;
      if (/^m|mes/.test(u)) return n * 30;
      return null;
    },
    celsiusFromAny(s) {
      if (!s) return null;
      const t = norm(s);
      // “38,5 °C”, “38.5”, “101 F”
      const m = t.match(
        /\b(3[5-9](?:[.,]\d)?|4[0-2](?:[.,]\d)?)\s*(?:°|º|graus)?\s*(?:c|celsius)?\b|\b(9[8-9]|1[0-1]\d(?:[.,]\d)?)\s*(?:°|º|graus)?\s*(?:f|fahrenheit)\b/
      );
      if (!m) return null;
      if (m[1]) return this.toFloat(m[1]);
      if (m[2]) {
        const f = this.toFloat(m[2]);
        return Number.isFinite(f) ? +(((f - 32) / 1.8).toFixed(1)) : null;
      }
      return null;
    }
  };

  const LR = { // LRs aproximados para Centor/McIsaac combinados
    "-1": 0.16, "0": 0.16, "1": 0.30, "2": 0.75, "3": 2.10, "4": 6.30, "5": 6.30
  };
  function postTestProb(pre, lr) {
    pre = clamp01(pre);
    if (pre === 0) return 0;
    if (pre === 1) return 1;
    const odds = pre / (1 - pre);
    const post = odds * (lr || 1);
    return post / (1 + post);
  }

  function toTopN(map, N = 3) {
    const arr = Object.entries(map || {}).map(([dx, p]) => ({ dx, probability: clamp01((+p || 0) / 100) }));
    arr.sort((a, b) => b.probability - a.probability);
    return arr.slice(0, N);
  }

  // --------------- Parser clínico (texto livre) ---------------
  function parseClinicalText(text) {
    const t = norm(text || "");

    // duração
    let durationDays = null;
    let durationTextNorm = null;
    const md = t.match(/\b(?:ha|há)?\s*(\d+[.,]?\d*)\s*(horas?|h|dias?|d|semanas?|sem|mes(?:es)?|m)\b/);
    if (md) {
      durationDays = NUM.daysFrom(md[0]);
      const n = NUM.toFloat(md[1]);
      const u = /h/.test(md[2]) ? "h" : /d/.test(md[2]) ? "d" : /sem/.test(md[2]) ? "sem" : "m";
      durationTextNorm = `${n}${u}`;
    }

    // trajetória
    let trajectory = null;
    if (/\bdupla\s+piora\b/.test(t)) trajectory = "dupla_piora";
    else if (/\bpiorand[oa]\b/.test(t)) trajectory = "piorando";
    else if (/\bmelhorand[oa]\b/.test(t)) trajectory = "melhorando";
    else if (/\best[áa]vel\b/.test(t) || /\bigual\b/.test(t)) trajectory = "estavel";

    // febre máxima
    let feverMaxC = null;
    const mf = t.match(/\b(?:tmax|temperatura|max(?:ima)?)\s*[:=]?\s*([\d.,º°\s\w]+)\b|(?:febre|febril)\s*(?:de|até|máx\.?)?\s*([\d.,º°\s\w]+)\b/);
    if (mf) feverMaxC = NUM.celsiusFromAny(mf[1] || mf[2]);
    if (!feverMaxC) {
      const m2 = t.match(/\b(3[7-9](?:[.,]\d)?|4[0-2](?:[.,]\d)?)\b/);
      if (m2) {
        const maybe = NUM.toFloat(m2[1]);
        if (maybe && maybe >= 37.5) feverMaxC = maybe;
      }
    }

    // dor (bucket + NRS)
    let painLabel = null, painNRS = null;
    if (/dor\s*(?:leve|fraca|suport[aá]vel)/.test(t)) painLabel = "leve";
    else if (/dor\s*moderad[ao]/.test(t)) painLabel = "moderada";
    else if (/dor\s*(?:intensa|forte|muito forte|insuport[aá]vel)/.test(t)) painLabel = "intensa";
    const mN = t.match(/\b(\d{1,2})\s*\/\s*10\b|\bnrs\s*(\d{1,2})\b/);
    if (mN) {
      painNRS = Math.max(0, Math.min(10, parseInt(mN[1] || mN[2], 10)));
      if (!painLabel) painLabel = painNRS >= 8 ? "intensa" : painNRS >= 4 ? "moderada" : "leve";
    }

    // negações
    const neg = {
      fever: /\b(sem|nega|não tem)\s+febre\b/.test(t) || /\bafebril\b/.test(t),
      cough: /\b(sem|nega|não tem)\s+tosse\b/.test(t),
      rhinorrhea: /\b(sem|nega|não tem)\s+(coriza|catarro)\b/.test(t),
      nasalObstruction: /\b(sem|nega|não tem)\s+(nariz\s*entupido|obstru[cç][aã]o)\b/.test(t),
      soreThroat: /\b(sem|nega|não tem)\s+(dor\s*de\s*garganta|odinof[aá]gia)\b/.test(t),
      earPain: /\b(sem|nega|não tem)\s+(dor\s*(no|de)\s*ouvido|otalgia)\b/.test(t),
      earDischarge: /\b(sem|nega|não tem)\s+(secre[cç][aã]o|pus)\b.*ouvido/.test(t),
    };

    // flags úteis
    const flags = {
      tonsilExudate: /\b(pus|placa|exsudat)/.test(t),
      unilateral: /(um lado|apenas\s*um|s[óo]\s*(?:no\s*)?(?:direito|esquerdo))/.test(t),
      pulsatileTinnitus: /(puls[aá]til|bate|batimento).*(zumbido|ouvido)/.test(t),
    };

    return { durationDays, durationTextNorm, trajectory, feverMaxC, pain: { label: painLabel, nrs: painNRS }, negations: neg, flags };
  }

  // --------------- Red flags ---------------
  const REDFLAG_PATTERNS = [
    /falta\s*de\s*ar|dispneia/i,
    /dificuldade\s*para\s*respirar|estridor/i,
    /dor\s*muito\s*intensa|insuport[aá]vel/i,
    /sangramento\s*(volumoso|intenso|ativo)/i,
    /rigidez\s*de\s*pescoc|meningismo/i,
    /confus[aã]o|desmaio|alter[aç][ã]o neurol[oó]gica/i,
  ];
  function detectRedFlags(text) {
    const t = String(text || "");
    const hits = [];
    for (const re of REDFLAG_PATTERNS) if (re.test(t)) hits.push(re.source);
    return { any: hits.length > 0, patterns: hits };
  }

  // --------------- Normalização de sintomas da UI ---------------
  // Features internas
  const FEAT = {
    FEVER: "fever", COUGH: "cough", SORE: "soreThroat",
    NASAL_OBS: "nasalObstruction", RHINO: "rhinorrhea", FACIAL: "facialPressure",
    SMELL: "smellLoss", TASTE: "tasteLoss",
    EAR_PAIN: "earPain", EAR_FULL: "earFullness", HEAR_LOSS: "hearingLoss",
    ITCH_EAR: "itchEar", TINNITUS: "tinnitus", DIZZ: "dizziness", PRESYNC: "presyncope",
    HALITOSIS: "halitosis", GLOBUS: "globus", DYSPHAGIA: "dysphagia",
    NECK_NODES: "neckNodes", SNORING: "snoring", DISCHARGE: "dischargeEar"
  };

  // keys da UI → feature interna
  const UIKEY_TO_FEAT = {
    febre: FEAT.FEVER,
    tosse: FEAT.COUGH,
    dor_de_garganta: FEAT.SORE,
    nariz_entupido: FEAT.NASAL_OBS,
    coriza: FEAT.RHINO,
    pressao_na_face: FEAT.FACIAL,
    reducao_olfato: FEAT.SMELL,
    reducao_paladar: FEAT.TASTE,
    dor_de_ouvido: FEAT.EAR_PAIN,
    sensacao_ouvido_tapado: FEAT.EAR_FULL,
    dificuldade_de_ouvir: FEAT.HEAR_LOSS,
    coceira_no_ouvido: FEAT.ITCH_EAR,
    zumbido: FEAT.TINNITUS,
    tontura: FEAT.DIZZ,
    sensacao_de_desmaio: FEAT.PRESYNC,
    mau_halito: FEAT.HALITOSIS,
    bolo_na_garganta: FEAT.GLOBUS,
    disfagia: FEAT.DYSPHAGIA,
    linfonodos_cervicais: FEAT.NECK_NODES,
    roncos: FEAT.SNORING,
    secrecao_otica: FEAT.DISCHARGE
  };

  // tokens comuns no rules.json → feature interna (se existir symptom_weights)
  const RULE_TOKEN_TO_FEAT = {
    odinofagia: FEAT.SORE,
    rinorreia: FEAT.RHINO,
    obstrucao_nasal: FEAT.NASAL_OBS,
    otalgia: FEAT.EAR_PAIN,
    otorreia: FEAT.DISCHARGE,
    halitose: FEAT.HALITOSIS,
    disfagia: FEAT.DYSPHAGIA,
    adenomegalia_cervical: FEAT.NECK_NODES,
    hiposmia: FEAT.SMELL,
    disgeusia: FEAT.TASTE,
    zumbido: FEAT.TINNITUS,
    tontura: FEAT.DIZZ,
    hipoacusia: FEAT.HEAR_LOSS,
    pressao_facial: FEAT.FACIAL,
    tosse: FEAT.COUGH,
    febre: FEAT.FEVER
  };

  // extrai features booleans a partir de keys + texto + negações
  function featuresFromInput(payload, parsed) {
    const text = norm(payload?.freeText || "");
    const keys = new Set((payload?.symptoms || []).map(k => norm(k)));

    const hasKey = (k) => keys.has(k);

    const f = {
      [FEAT.FEVER]: hasKey("febre") || /\bfebre|febril\b/.test(text),
      [FEAT.COUGH]: hasKey("tosse") || /\btosse\b/.test(text),
      [FEAT.SORE]: hasKey("dor_de_garganta") || /\bdor de garganta|odinof[aá]gia\b/.test(text),
      [FEAT.NASAL_OBS]: hasKey("nariz_entupido") || /\bobstru[cç][aã]o|nariz entupido\b/.test(text),
      [FEAT.RHINO]: hasKey("coriza") || /\bcoriza|catarro\b/.test(text),
      [FEAT.FACIAL]: hasKey("pressao_na_face") || /\b(dor|press[aã]o)\s*(facial|na face)\b/.test(text),
      [FEAT.SMELL]: hasKey("reducao_olfato") || /\b(anosmia|sem olfato)\b/.test(text),
      [FEAT.TASTE]: hasKey("reducao_paladar"),
      [FEAT.EAR_PAIN]: hasKey("dor_de_ouvido") || /\botalgia|dor.*ouvido\b/.test(text),
      [FEAT.EAR_FULL]: hasKey("sensacao_ouvido_tapado"),
      [FEAT.HEAR_LOSS]: hasKey("dificuldade_de_ouvir") || /\bhipoacusia|ou[cç]o pior\b/.test(text),
      [FEAT.ITCH_EAR]: hasKey("coceira_no_ouvido"),
      [FEAT.TINNITUS]: hasKey("zumbido"),
      [FEAT.DIZZ]: hasKey("tontura"),
      [FEAT.PRESYNC]: hasKey("sensacao_de_desmaio"),
      [FEAT.HALITOSIS]: hasKey("mau_halito"),
      [FEAT.GLOBUS]: hasKey("bolo_na_garganta"),
      [FEAT.DYSPHAGIA]: hasKey("disfagia") || /\bdisfagia|dificuldade (?:pra|para) engolir\b/.test(text),
      [FEAT.NECK_NODES]: hasKey("linfonodos_cervicais") || /g[âa]nglios|caro[cç]o no pesco[cç]o|adenomegalia/.test(text),
      [FEAT.SNORING]: hasKey("roncos"),
      [FEAT.DISCHARGE]: hasKey("secrecao_otica") || /secre[cç][aã]o|pus.*ouvido/.test(text),
      unilateral: parsed?.flags?.unilateral || /(um lado|apenas\s*um|s[óo]\s*(?:no\s*)?(?:direito|esquerdo))/.test(text),
      pulsatileTinnitus: parsed?.flags?.pulsatileTinnitus || /(puls[aá]til|bate|batimento).*(zumbido|ouvido)/.test(text)
    };

    // aplicar negações do parser (precedência)
    if (parsed?.negations) {
      if (parsed.negations.fever) f[FEAT.FEVER] = false;
      if (parsed.negations.cough) f[FEAT.COUGH] = false;
      if (parsed.negations.soreThroat) f[FEAT.SORE] = false;
      if (parsed.negations.nasalObstruction) f[FEAT.NASAL_OBS] = false;
      if (parsed.negations.rhinorrhea) f[FEAT.RHINO] = false;
      if (parsed.negations.earPain) f[FEAT.EAR_PAIN] = false;
      if (parsed.negations.earDischarge) f[FEAT.DISCHARGE] = keys.has("secrecao_otica"); // só mantém se marcado explicitamente
    }

    return f;
  }

  // --------------- Follow-ups ---------------
  function followupQuestions(top3, input, parsed) {
    const qs = [];
    const add = (q) => { if (q && !qs.includes(q)) qs.push(q); };
    const traj = parsed?.trajectory;
    const dur = parsed?.durationDays ?? null;

    for (const it of top3 || []) {
      const name = norm(it.dx || "");
      // OUVIDO
      if (name.includes("otite externa")) {
        add("Teve exposição a água/piscina recentemente?");
        add("Dói ao tocar ou puxar a orelha?");
        add("Há coceira no canal do ouvido?");
      }
      if (name.includes("otite média")) {
        add("A dor começou de forma súbita?");
        add("Teve febre nas últimas 24–48 horas?");
        add("Observou secreção saindo do ouvido?");
      }
      if (name.includes("disfunção tub") || name.includes("otite serosa")) {
        add("A sensação de ouvido tapado piora com resfriados ou mudanças de altitude/voo?");
        add("Sente pressão ao engolir/bocejar?");
      }
      if (name.includes("perda auditiva súbita")) {
        add("A perda auditiva começou de repente (horas/dia)?");
        add("É pior em um lado só?");
      }
      if (name.includes("zumbido puls")) {
        add("O zumbido acompanha batimentos (pulsátil)?");
        add("O zumbido é de um lado só?");
      }
      // NARIZ
      if (name.includes("rinossinusite crônica")) {
        add("Há quanto tempo os sintomas persistem (semanas/meses)?");
        add("Há secreção espessa/amarelada e pressão que piora ao abaixar a cabeça?");
        add("Teve redução importante do olfato?");
      }
      if (name.includes("rinite al")) {
        add("Tem coceira no nariz/olhos e espirros em salva?");
        add("Os sintomas pioram em épocas específicas (sazonalidade)?");
      }
      if (name.includes("bacteriana")) {
        add("Houve 'dupla piora' após melhora inicial?");
        add("Os sintomas persistem ≥10 dias sem melhora?");
      } else if (name.includes("rinite inespec") || name.includes("resfriado") || name.includes("viral")) {
        add("Há febre alta ou piora após 5–7 dias de sintomas?");
      }
      if (name.includes("epistaxe")) {
        add("O sangramento foi unilateral e durou mais de 10 minutos?");
        add("Usa anticoagulantes ou antiagregantes?");
      }
      // GARGANTA
      if (name.includes("estrept") || name.includes("gabhs")) {
        add("Há placas/pus nas amígdalas?");
        add("Está sem tosse e teve febre?");
        add("A dor iniciou rapidamente e piora ao engolir?");
      }
      if (name.includes("viral")) {
        add("Tem sintomas de resfriado (nariz entupido/coriza/tosse)?");
      }
      if (name.includes("mononucleose")) {
        add("Sente cansaço extremo ou linfonodos aumentados?");
      }
      if (name.includes("disfonia") || name.includes("rouquid")) {
        add("Há quantas semanas está rouco(a)? Passa de 3–4 semanas?");
        add("Fuma ou trabalha em ambiente com pó/químicos?");
      }
      // PESCOÇO
      if (name.includes("linfadenite") || name.includes("linfadenop")) {
        add("O caroço no pescoço é doloroso ao toque?");
        add("Há febre, perda de peso ou suores noturnos?");
        add("Há quantos dias o gânglio está aumentado?");
      }
    }

    if (qs.length === 0) {
      add("Quando os sintomas começaram e como evoluíram desde então?");
      add("Algo piora ou alivia os sintomas?");
      add("Teve febre, secreções ou dor muito intensa?");
    }

    if (traj) {
      const i = qs.findIndex(q => /evolu[iç]ão|começaram/.test(norm(q)));
      if (i >= 0) qs.splice(i, 1);
    }
    if (dur != null) {
      const j = qs.findIndex(q => /quando os sintomas começaram/.test(norm(q)));
      if (j >= 0) qs.splice(j, 1);
    }
    return qs.slice(0, 6);
  }

  // --------------- Heurísticas por domínio ---------------
  function dx_garganta(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const age = input.age ?? 30;
    const txt = norm(input.freeText || "");
    const out = {};
    const why = {};

    let score = 0;
    if (f[FEAT.FEVER]) score += 1;
    if (!f[FEAT.COUGH]) score += 1;
    if (f[FEAT.NECK_NODES]) score += 1;
    const tonsilExudate = parsed?.flags?.tonsilExudate || (f[FEAT.SORE] && /(pus|placa|exsudat)/.test(txt));
    if (tonsilExudate) score += 1;

    let pre = 0.10;
    if (age >= 3 && age <= 14) { score += 1; pre = 0.25; }
    else if (age >= 45) { score -= 1; pre = 0.10; }

    if (parsed?.trajectory === "piorando" && (parsed?.durationDays ?? 0) >= 3) {
      score = Math.min(5, score + 1);
    }

    const pGabhs = postTestProb(pre, LR[String(score)] ?? 0.75);

    if (pGabhs > 0) {
      out["Faringite estreptocócica (GABHS)"] = pGabhs * 100;
      why["Faringite estreptocócica (GABHS)"] = [
        f[FEAT.SORE] ? "odinofagia" : null,
        !f[FEAT.COUGH] ? "sem tosse" : null,
        f[FEAT.FEVER] ? "febre" : null,
        tonsilExudate ? "placas/exsudato" : null,
        (age >= 3 && age <= 14) ? "faixa pediátrica (McIsaac)" : (age >= 45 ? "idade ≥45 reduz" : null),
        parsed?.trajectory === "piorando" ? "trajetória de piora" : null,
      ].filter(Boolean);
    }

    const extremeFatigue = /(cansa[cç]o extremo|exaust[aã]o|muito cansad)/.test(txt);
    const pMono = tonsilExudate && extremeFatigue ? 0.6 : 0.05;
    if (pMono > 0.05) {
      out["Mononucleose infecciosa"] = pMono * 100;
      why["Mononucleose infecciosa"] = ["exsudato + fadiga importante"];
    }

    const pViral = clamp01(1 - clamp01(pGabhs) - clamp01(pMono));
    out["Faringite viral inespecífica"] = Math.max(out["Faringite viral inespecífica"] || 0, pViral * 100);

    if (/rouquid[aã]o|disfonia|voz rouca|voz cansada/.test(txt)) {
      const weeks = /(\d+)\s*semana/.test(input.duration || parsed?.durationTextNorm || "") ? parseInt(RegExp.$1, 10) : null;
      if (/sangue na saliva|perda de peso|caro[cç]o no pesco[cç]o/.test(txt)) {
        out["Sinal de alarme (excluir neoplasia de laringe)"] = 100;
      } else if (weeks !== null && weeks >= 4) {
        out["Disfonia crônica (avaliar laringe)"] = Math.max(out["Disfonia crônica (avaliar laringe)"] || 0, 70);
      } else {
        out["Laringite aguda (viral/uso de voz)"] = Math.max(out["Laringite aguda (viral/uso de voz)"] || 0, 60);
      }
    }

    const list = toTopN(out).map(i => ({ ...i, whyFor: why[i.dx] || undefined }));
    return { list, confidence: list[0]?.probability ?? 0.6 };
  }

  function dx_ouvido(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const age = input.age ?? null;
    const out = {};
    const why = {};

    const primary = f[FEAT.HEAR_LOSS] || f[FEAT.EAR_FULL] || f[FEAT.DISCHARGE] || f[FEAT.EAR_PAIN];

    if (primary) {
      if ((parsed?.durationDays ?? 0) > 2 && f[FEAT.EAR_PAIN] && f[FEAT.FEVER]) {
        out["Otite média aguda"] = Math.max(out["Otite média aguda"] || 0, 88);
        why["Otite média aguda"] = ["otalgia + febre", `duração ${Math.round(parsed.durationDays)}d`];
      }
      if (f[FEAT.ITCH_EAR] || /puxar.*orelha|dor ao tocar/.test(txt) || /(piscina|mergulho|entrou [áa]gua|nado)/.test(txt)) {
        out["Otite externa aguda"] = Math.max(out["Otite externa aguda"] || 0, 90);
        why["Otite externa aguda"] = ["dor ao toque/puxar", "coceira", "exposição à água/piscina"];
      }
      if (f[FEAT.EAR_FULL] && !f[FEAT.FEVER] && !f[FEAT.DISCHARGE]) {
        out["Disfunção tubária / otite serosa"] = Math.max(out["Disfunção tubária / otite serosa"] || 0, 70);
        why["Disfunção tubária / otite serosa"] = ["plenitude sem febre/secreção"];
      }
      if (!out["Otite externa aguda"] && !out["Otite média aguda"] && !out["Disfunção tubária / otite serosa"]) {
        out["Outra causa otogênica"] = 100;
      }
    } else {
      if (/mastigar|abrir a boca/.test(txt)) out["DTM (ATM)/mastigação – otalgia referida"] = 65;
      else if (f[FEAT.SORE]) out["Origem faríngea (faringite/amigdalite) – otalgia referida"] = 90;
      else out["Otalgia referida (dental/oral/cervical)"] = 100;
    }

    if (f[FEAT.TINNITUS]) {
      if (f.pulsatileTinnitus) out["Zumbido pulsátil (avaliar causas vasculares)"] = 100;
      else if (f.unilateral && (f[FEAT.HEAR_LOSS] || /s[úu]bita|piorou r[aá]pido/.test(txt)))
        out["Perda auditiva súbita/assimétrica (prioritário)"] = Math.max(out["Perda auditiva súbita/assimétrica (prioritário)"] || 0, 85);
      else if (f[FEAT.HEAR_LOSS]) out["Perda auditiva neurossensorial (presbiacusia/ruído)"] = Math.max(out["Perda auditiva neurossensorial (presbiacusia/ruído)"] || 0, 70);
      else out["Zumbido não pulsátil inespecífico"] = Math.max(out["Zumbido não pulsátil inespecífico"] || 0, 70);
    }

    if (age != null) {
      if (age <= 6) out["Otite média aguda"] = Math.max(out["Otite média aguda"] || 0, 85);
      if (age >= 60 && f[FEAT.HEAR_LOSS]) out["Perda auditiva neurossensorial (presbiacusia/ruído)"] = Math.max(out["Perda auditiva neurossensorial (presbiacusia/ruído)"] || 0, 80);
    }

    const list = toTopN(out);
    return { list, confidence: list[0]?.probability ?? 0.65 };
  }

  function dx_nariz(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const age = input.age ?? null;
    const out = {};

    const dupWorse = parsed?.trajectory === "dupla_piora";
    const longSymptoms = (parsed?.durationDays ?? 0) >= 10;
    const highFever = (parsed?.feverMaxC ?? 0) >= 39;
    const purulent = /purul|amarel|esverde/.test(txt) || (f[FEAT.RHINO] && /gross[ao]|espess/.test(txt));

    if ((dupWorse || longSymptoms || (highFever && purulent)) && (f[FEAT.FACIAL] || f[FEAT.NASAL_OBS])) {
      out["Rinossinusite bacteriana"] = 75;
    }

    const CRS = (f[FEAT.NASAL_OBS] || f[FEAT.RHINO]) && (f[FEAT.FACIAL] || f[FEAT.SMELL]) && (parsed?.durationDays ?? 0) >= 12 * 7;
    if (CRS) {
      if (f[FEAT.SMELL] && /(complet[ao]|sem olfato)/.test(txt)) {
        out["Rinossinusite crônica com polipose"] = 90;
        out["Rinossinusite crônica não poliposa"] = 10;
      } else {
        out["Rinossinusite crônica provável"] = Math.max(out["Rinossinusite crônica provável"] || 0, 75);
      }
    } else if (!out["Rinossinusite bacteriana"]) {
      const allergic = /coceir|espirr/.test(txt) || (f[FEAT.RHINO] && !f[FEAT.FEVER]);
      if (allergic) out["Rinite alérgica"] = 80;
      if (f[FEAT.NASAL_OBS] || f[FEAT.RHINO] || f[FEAT.FACIAL]) out["Rinite inespecífica / resfriado"] = Math.max(out["Rinite inespecífica / resfriado"] || 0, 70);
    }

    if (/sangr|epistax/.test(txt)) out["Epistaxe (sangramento nasal)"] = Math.max(out["Epistaxe (sangramento nasal)"] || 0, 70);

    if (age != null && age <= 25) out["Rinite alérgica"] = Math.max(out["Rinite alérgica"] || 0, 85);

    const list = toTopN(out);
    return { list, confidence: list[0]?.probability ?? 0.6 };
  }

  function dx_pescoco(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const out = {};

    if (f[FEAT.NECK_NODES]) {
      if (f[FEAT.FEVER] || f[FEAT.SORE] || f[FEAT.RHINO]) {
        out["Linfadenite reativa/infecciosa cervical"] = 70;
        out["Linfadenopatia inespecífica"] = 30;
      } else if (/perda de peso|noit(es)? suadas|cansa[cç]o prolongado/.test(txt)) {
        out["Linfadenopatia – investigar causas sistêmicas"] = 60;
        out["Linfadenopatia inespecífica"] = 40;
      } else {
        out["Linfadenopatia inespecífica"] = 100;
      }
    } else {
      out["Queixa de pescoço inespecífica"] = 100;
    }

    const list = toTopN(out);
    return { list, confidence: list[0]?.probability ?? 0.55 };
  }

  // --------------- Regras (opcional) ---------------
  // Se existir rules.domains[domain].dx[].symptom_weights e .modifiers, aplicamos como “nudge”.
  function computeByRules(payload, parsed, rules) {
    if (!rules || !payload?.domain) return {};
    const dom = rules.domains?.[payload.domain];
    if (!dom || !Array.isArray(dom.dx)) return {};

    const f = featuresFromInput(payload, parsed);
    const out = {};

    for (const d of dom.dx) {
      const name = d.name || d.dx || "dx";
      let p = clamp01(+d.prior || 0.15); // prior em 0..1

      // symptom_weights: tokens (ex.: odinofagia) → peso absoluto (0..1) ou delta
      const sw = d.symptom_weights || {};
      for (const token in sw) {
        const feat = RULE_TOKEN_TO_FEAT[token];
        if (!feat) continue;
        const present = !!f[feat];
        const w = +sw[token] || 0;
        if (present) p = clamp01(p + w); // simples: prior + somatório de pesos presentes
      }

      // modifiers (idade, duração, febre, trajetória, negations)
      const mod = d.modifiers || {};
      const dd = parsed?.durationDays ?? null;
      const tmax = parsed?.feverMaxC ?? null;

      if (Array.isArray(mod.age) && payload.age != null) {
        for (const m of mod.age) {
          if ((m.lte != null && payload.age <= m.lte) || (m.gte != null && payload.age >= m.gte)) {
            if (m.boost != null) p = clamp01(p + m.boost);
            if (m.multiplier != null) p = clamp01(p * m.multiplier);
          }
        }
      }
      if (Array.isArray(mod.duration_days) && dd != null) {
        for (const m of mod.duration_days) {
          if ((m.lte != null && dd <= m.lte) || (m.gte != null && dd >= m.gte)) {
            if (m.boost != null) p = clamp01(p + m.boost);
            if (m.multiplier != null) p = clamp01(p * m.multiplier);
          }
        }
      }
      if (Array.isArray(mod.fever_max_c) && tmax != null) {
        for (const m of mod.fever_max_c) {
          if ((m.lte != null && tmax <= m.lte) || (m.gte != null && tmax >= m.gte)) {
            if (m.boost != null) p = clamp01(p + m.boost);
            if (m.multiplier != null) p = clamp01(p * m.multiplier);
          }
        }
      }
      if (Array.isArray(mod.trajectory) && parsed?.trajectory) {
        for (const m of mod.trajectory) {
          if (m.is && norm(m.is) === norm(parsed.trajectory)) {
            if (m.min_duration_days == null || (dd != null && dd >= m.min_duration_days)) {
              if (m.boost != null) p = clamp01(p + m.boost);
              if (m.multiplier != null) p = clamp01(p * m.multiplier);
            }
          }
        }
      }
      if (mod.negations) {
        for (const tok in mod.negations) {
          const feat = RULE_TOKEN_TO_FEAT[tok] || tok;
          const neg = parsed?.negations;
          if (feat === FEAT.COUGH && neg?.cough) p = clamp01(p + (+mod.negations[tok] || 0));
          if (feat === FEAT.FEVER && neg?.fever) p = clamp01(p + (+mod.negations[tok] || 0));
        }
      }

      out[name] = Math.round(p * 100);
    }
    return out;
  }

  function blendMaps(primary /*heurísticas*/, secondary /*rules*/, w = 0.6) {
    const out = { ...primary };
    const keys = new Set([...Object.keys(primary || {}), ...Object.keys(secondary || {})]);
    for (const k of keys) {
      const a = +primary[k] || 0, b = +secondary[k] || 0;
      out[k] = Math.round(clamp01((w * (a / 100) + (1 - w) * (b / 100))) * 100);
    }
    return out;
  }

  // --------------- Referências (para relatório se necessário) ---------------
  const REFERENCES = [
    "IDSA – ABRS (rinossinusite aguda bacteriana).",
    "IDSA – Faringite por Streptococcus (Centor/McIsaac).",
    "AAP/AAO-HNS – Otite Média Aguda.",
    "AAO-HNSF – Disfonia/rouquidão.",
    "AAO-HNSF – Perda auditiva súbita."
  ];

  // --------------- API pública ---------------
  function localDifferentials(payload, rules) {
    if (!payload || !payload.domain) {
      return { list: [], confidence: 0, notes: ["domínio ausente"], references: REFERENCES.slice() };
    }

    // parser clínico e projeção no payload
    const parsed = parseClinicalText(payload.freeText || "");
    payload.extras = Object.assign({}, payload.extras || {}, { parsed });
    if (!payload.duration && parsed.durationTextNorm) payload.duration = parsed.durationTextNorm;

    // red flags
    const redFlags = detectRedFlags(payload.freeText);

    // heurísticas por domínio
    let base;
    switch (payload.domain) {
      case "garganta": base = dx_garganta(payload, parsed); break;
      case "ouvido":   base = dx_ouvido(payload, parsed);   break;
      case "nariz":    base = dx_nariz(payload, parsed);    break;
      case "pescoco":  base = dx_pescoco(payload, parsed);  break;
      default: return { list: [], confidence: 0, notes: ["domínio desconhecido"], references: REFERENCES.slice() };
    }

    // opcional: aplicar rules (se existirem) como “nudge”
    let finalList = base.list;
    if (rules && rules.domains && rules.domains[payload.domain]) {
      const ruleMap = computeByRules(payload, parsed, rules); // {dx: 0..100}
      const baseMap = {};
      for (const i of base.list || []) baseMap[i.dx] = Math.round((i.probability || 0) * 100);
      const blended = blendMaps(baseMap, ruleMap, 0.7); // heurística 70% + rules 30%
      finalList = toTopN(blended);
    }

    // follow-ups
    const questions = followupQuestions(finalList, payload, parsed);
    const unknownSx = (payload?.symptoms || []).filter(k => !UIKEY_TO_FEAT.hasOwnProperty(k));

    // confiança = prob do top1
    const confidence = finalList[0]?.probability ?? base.confidence ?? 0.6;

    return {
      list: finalList,
      confidence,
      gaps: { questions, unknownSx },
      redFlags,
      references: REFERENCES.slice()
    };
  }

  if (typeof window !== "undefined") window.localDifferentials = localDifferentials;
  if (typeof module !== "undefined") module.exports = { localDifferentials, parseClinicalText };
})(typeof window !== "undefined" ? window : globalThis);
    