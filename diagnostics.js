/* diagnostics.js (v3)
   Predição local Top-3 para OUVIDO / NARIZ / GARGANTA / PESCOCO,
   com parser clínico de texto livre, heurísticas por idade/sexo e follow-ups.

   API (compatível):
     localDifferentials(payload, rules) -> {
       list: [{ dx, probability: 0..1, whyFor?: string[], whyAgainst?: string[] }],
       confidence: 0..1,
       gaps?: { questions?: string[], unknownSx?: string[] },
       redFlags?: { any: boolean, patterns?: string[] },
       notes?: string[],
       references?: string[]                      // <— novo (para relatório)
     }

   payload esperado:
     {
       domain: "ouvido"|"nariz"|"garganta"|"pescoco",
       age: number|null,
       sex: "M"|"F"|"OUTRO"|null,
       duration: string|null,                     // mantido (ex.: "5 dias")
       symptoms: string[],                        // chaves do app-ui.js (ex.: "febre","dor_de_ouvido")
       freeText: string,
       extras?: object                            // preenchido com parsed
     }

   Aceite: “dor de garganta há 5 dias, piorando, sem tosse” recalcula sem abrir checklist.
*/

(function (global) {
  // ---------------- Utils ----------------
  const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0));
  const pct = (v) => Math.round(clamp01(v) * 100);
  const norm = (s) => (s || "").toLowerCase();

  const NUM = {
    toFloat(s) {
      if (s == null) return null;
      const t = String(s).replace(",", ".").replace(/[^\d.]/g, "");
      const v = parseFloat(t);
      return Number.isFinite(v) ? v : null;
    },
    daysFrom(durationText) {
      if (!durationText) return null;
      const t = norm(durationText);

      // ex.: "há 5 dias", "5 dias", "5d", "48h", "2 semanas", "3 meses"
      const re =
        /\b(?:ha|há)?\s*(\d+[,.]?\d*)\s*(dias?|d|semanas?|sem|mes(?:es)?|m|horas?|h)\b/;
      const m = t.match(re);
      if (!m) return null;

      const n = NUM.toFloat(m[1]);
      const unit = m[2];

      if (!Number.isFinite(n)) return null;

      if (/^h|horas?$/.test(unit)) return Math.max(0.04, n / 24); // >= 1h => fração de dia
      if (/^d|dias?$/.test(unit)) return n;
      if (/^sem|semanas?$/.test(unit)) return n * 7;
      if (/^m|mes/.test(unit)) return n * 30;
      return null;
    },
    celsiusFromAny(s) {
      if (!s) return null;
      const t = norm(s);
      // captura "38.5", "38,5", "38º", "38°C", "101F"
      const m = t.match(
        /\b(3[5-9](?:[.,]\d)?|4[0-2](?:[.,]\d)?)\s*(?:°|º|graus)?\s*(c|celsius)?\b|\b(9[8-9]|1[0-1]\d(?:[.,]\d)?)\s*(?:°|º|graus)?\s*(f|fahrenheit)\b/
      );
      if (!m) return null;

      if (m[1]) {
        return NUM.toFloat(m[1]); // já está em °C
      }
      if (m[3]) {
        const f = NUM.toFloat(m[3]);
        if (!Number.isFinite(f)) return null;
        return +( (f - 32) / 1.8 ).toFixed(1);
      }
      return null;
    },
  };

  function toTop3(obj) {
    const arr = Object.entries(obj).map(([dx, p]) => ({ dx, probability: clamp01((+p || 0) / 100) }));
    arr.sort((a, b) => b.probability - a.probability);
    return arr.slice(0, 3);
  }

  function uniq(arr) {
    return Array.from(new Set(arr || []));
  }

  // Bayes simples p/ testes diagnósticos (Centor/McIsaac p/ GABHS)
  function postTestProb(pre, lr) {
    pre = clamp01(pre);
    if (pre >= 1) return 1;
    const odds = pre / (1 - pre);
    const postOdds = odds * lr;
    return postOdds / (1 + postOdds);
  }

  // ---------------- Parser clínico de texto livre ----------------
  // Extrai: duração em dias, trajetória (piorando/melhorando/estável/oscilando/dupla piora),
  // febre máxima, dor (leve/moderada/intensa ou NRS), e negações (ex.: "sem tosse").
  function parseClinicalText(text) {
    const t = norm(text || "");

    // duração
    let durationDays = null;
    let durationTextNorm = null;
    const durMatch = t.match(/\b(?:ha|há)?\s*(\d+[,.]?\d*)\s*(dias?|d|semanas?|sem|mes(?:es)?|m|horas?|h)\b/);
    if (durMatch) {
      durationDays = NUM.daysFrom(durMatch[0]);
      const n = NUM.toFloat(durMatch[1]);
      const u = durMatch[2];
      const mapU = /h/.test(u) ? "h" : /d/.test(u) ? "d" : /sem|semana/.test(u) ? "sem" : "m";
      durationTextNorm = `${n}${mapU}`;
    }

    // trajetória
    let trajectory = null; // "piorando" | "melhorando" | "estável" | "oscilando" | "dupla_piora"
    if (/\bdupla\s+piora\b/.test(t)) trajectory = "dupla_piora";
    else if (/\bpiorand[oa]/.test(t)) trajectory = "piorando";
    else if (/\bmelhorand[oa]/.test(t)) trajectory = "melhorando";
    else if (/\best[áa]vel\b/.test(t)) trajectory = "estável";
    else if (/\boscilando|vai\s+e\s+volta|altos\s*e\s*baixos/.test(t)) trajectory = "oscilando";

    // febre máxima
    let feverMaxC = null;
    // exemplos: "Tmax 38.5", "febre 39", "39º", "101F"
    const feverCandidate = t.match(/\b(?:tmax|temperatura|max(?:ima)?)\s*[:=]?\s*([\d.,º°\s\w]+)\b|(?:febre|febril)\s*(?:de|até|máx\.?)?\s*([\d.,º°\s\w]+)\b/);
    if (feverCandidate) feverMaxC = NUM.celsiusFromAny(feverCandidate[1] || feverCandidate[2]);
    // fallback: número solto >= 37.5…
    if (!feverMaxC) {
      const m2 = t.match(/\b(3[7-9](?:[.,]\d)?|4[0-2](?:[.,]\d)?)\b/);
      if (m2) {
        const maybe = NUM.toFloat(m2[1]);
        if (maybe && maybe >= 37.5) feverMaxC = maybe;
      }
    }

    // dor: leve/moderada/intensa | NRS 0–10
    let painLabel = null;
    if (/dor\s*(?:leve|fraca|suport[aá]vel)/.test(t)) painLabel = "leve";
    else if (/dor\s*(?:moderad[ao])/.test(t)) painLabel = "moderada";
    else if (/dor\s*(?:intensa|forte|insuport[aá]vel|muito forte)/.test(t)) painLabel = "intensa";
    // NRS
    let painNRS = null;
    const mNrs = t.match(/\b(\d{1,2})\s*\/\s*10\b|\bNRS\s*(\d{1,2})\b/);
    if (mNrs) {
      const n = parseInt(mNrs[1] || mNrs[2], 10);
      if (Number.isFinite(n)) painNRS = Math.max(0, Math.min(10, n));
      if (!painLabel) {
        painLabel = n >= 8 ? "intensa" : n >= 4 ? "moderada" : "leve";
      }
    }

    // negações (“sem tosse”, “nega febre”, etc.)
    const neg = {
      cough: /\b(sem|nega|não tem)\s+tosse\b/.test(t),
      fever: /\b(sem|nega|não tem)\s+febre\b/.test(t),
      rhinorrhea: /\b(sem|nega|não tem)\s+(coriza|catarro)\b/.test(t),
      nasalObstruction: /\b(sem|nega|não tem)\s+(nariz\s*entupido|obstru[cç][aã]o)\b/.test(t),
      soreThroat: /\b(sem|nega|não tem)\s+(dor\s*de\s*garganta|odinof[aá]gia)\b/.test(t),
      earPain: /\b(sem|nega|não tem)\s+(dor\s*(no|de)\s*ouvido|otalgia)\b/.test(t),
      earDischarge: /\b(sem|nega|não tem)\s+(secre[cç][aã]o|pus)\b.*ouvido/.test(t),
    };

    // achados específicos úteis
    const flags = {
      tonsilExudate: /\b(pus|placa|exsudat)/.test(t),
      unilateral: /(um lado|s[óo]\s*(?:no|no\s*lado)\s*(?:direito|esquerdo)|apenas\s*um)/.test(t),
      pulsatileTinnitus: /(puls[aá]til|bate|batimento).*(zumbido|ouvido)/.test(t),
    };

    return {
      durationDays,
      durationTextNorm,
      trajectory,
      feverMaxC,
      pain: { label: painLabel, nrs: painNRS },
      negations: neg,
      flags,
    };
  }

  // ---------------- Red flags (texto livre) ----------------
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

  // ---------------- Integração com rules_otorrino.json ----------------
  // Observação: nosso app envia "symptoms" com CHAVES (ex.: "febre","dor_de_ouvido").
  // Por isso, mapeamos diretamente essas chaves e também conferimos o texto livre.
  function featuresFromInput(payload, parsed) {
    const S = new Set((payload?.symptoms || []).map(norm));
    const t = norm(payload?.freeText || "");

    const has = (key) => S.has(key);

    // sinais (combina checklist + texto livre, com override por negação)
    let fever = has("febre") || /\b(febre|febril)\b/.test(t);
    let cough = has("tosse") || /\btosse\b/.test(t);
    let soreThroat = has("dor_de_garganta") || /\bdor de garganta|odinof[aá]gia\b/.test(t);
    let nasalObstruction = has("nariz_entupido") || /\bobstru[cç][aã]o|nariz entupido\b/.test(t);
    let rhinorrhea = has("coriza") || /\bcoriza|catarro\b/.test(t);
    let facialPressure = has("pressao_na_face") || /\b(dor|press[aã]o)\s*(facial|na face)\b/.test(t);
    let smellLoss = has("reducao_olfato") || /\b(anosmia|sem olfato)\b/.test(t);
    let tasteLoss = has("reducao_paladar");
    let earPain = has("dor_de_ouvido") || /otalgia|dor.*ouvido/.test(t);
    let earFullness = has("sensacao_ouvido_tapado");
    let hearingLoss = has("dificuldade_de_ouvir") || /\bhipoacusia|ou[cç]o pior\b/.test(t);
    let itchEar = has("coceira_no_ouvido");
    let tinnitus = has("zumbido");
    let dizziness = has("tontura");
    let presyncope = has("sensacao_de_desmaio");
    let halitosis = has("mau_halito");
    let globus = has("bolo_na_garganta");
    let dysphagia = has("disfagia") || /\bdisfagia|dificuldade (?:pra|para) engolir\b/.test(t);
    let neckNodes = has("linfonodos_cervicais") || /g[âa]nglios|caro[cç]o no pesco[cç]o|adenomegalia/.test(t);
    let snoring = has("roncos");
    const dischargeEar = has("secrecao_otica") || /secre[cç][aã]o|pus.*ouvido/.test(t);

    // negações (parser) têm precedência
    if (parsed?.negations) {
      if (parsed.negations.fever) fever = false;
      if (parsed.negations.cough) cough = false;
      if (parsed.negations.soreThroat) soreThroat = false;
      if (parsed.negations.nasalObstruction) nasalObstruction = false;
      if (parsed.negations.rhinorrhea) rhinorrhea = false;
      if (parsed.negations.earPain) earPain = false;
      if (parsed.negations.earDischarge) {
        // só nega se não veio marcado explicitamente no checklist
        if (!has("secrecao_otica")) {
          // manter 'dischargeEar' coerente
          // (não zera o texto livre se o usuário marcou a opção)
          // aqui zeramos apenas se não veio marcado
          // eslint-disable-next-line no-var
          var _dischargeEar = false;
        }
      }
    }

    // flags adicionais
    const unilateral =
      parsed?.flags?.unilateral ||
      /(um lado|lateral|s[óo] no direito|s[óo] no esquerdo)/.test(t);
    const pulsatileTinnitus = parsed?.flags?.pulsatileTinnitus || /(puls[aá]til|bate|batimento).*(zumbido|ouvido)/.test(t);

    return {
      fever,
      cough,
      soreThroat,
      nasalObstruction,
      rhinorrhea,
      facialPressure,
      smellLoss,
      tasteLoss,
      earPain,
      earFullness,
      hearingLoss,
      itchEar,
      tinnitus,
      dizziness,
      presyncope,
      halitosis,
      globus,
      dysphagia,
      neckNodes,
      snoring,
      dischargeEar: parsed?.negations?.earDischarge ? false : dischargeEar,
      unilateral,
      pulsatileTinnitus,
    };
  }

  // ---------------- Follow-ups (contextuais) ----------------
  function followupQuestions(top3, input, parsed) {
    const qs = [];
    const add = (q) => { if (q && !qs.includes(q)) qs.push(q); };

    const traj = parsed?.trajectory;
    const dur = parsed?.durationDays ?? null;

    for (const item of top3 || []) {
      const name = norm(item.dx || "");

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
        add("Sente pressão no ouvido ao engolir/bocejar?");
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
        add("Há secreção nasal espessa/amarelada ou pressão que piora ao abaixar a cabeça?");
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

    // Fallback genérico
    if (qs.length === 0) {
      add("Quando os sintomas começaram e como evoluíram desde então?");
      add("Algo piora ou alivia os sintomas?");
      add("Teve febre, secreções ou dor muito intensa?");
    }

    // Enxugar (não perguntar o que já sabemos pela trajetória/duração)
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

  // ---------------- Módulos por domínio ----------------

  // Garganta (Centor/McIsaac + texto)
  function dx_garganta(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const age = input.age ?? 30;
    const txt = norm(input.freeText || "");
    const out = {};
    const why = {};

    // Centor/McIsaac
    let score = 0;
    if (f.fever) score += 1;
    if (!f.cough) score += 1;
    if (f.neckNodes) score += 1;
    const tonsilExudate = parsed?.flags?.tonsilExudate || (f.soreThroat && /(pus|placa|exsudat)/.test(txt));
    if (tonsilExudate) score += 1;

    let pre = 0.10;
    if (age >= 3 && age <= 14) { score += 1; pre = 0.25; }
    else if (age >= 45) { score -= 1; pre = 0.10; }

    // Trajetória: piora após 3–5d favorece bacteriana levemente
    if (parsed?.trajectory === "piorando" && (parsed?.durationDays ?? 0) >= 3) {
      score = Math.min(5, score + 1);
    }

    const lrMap = { "-1": 0.16, "0": 0.16, "1": 0.3, "2": 0.75, "3": 2.1, "4": 6.3, "5": 6.3 };
    const lr = lrMap[String(score)] ?? 0.75;
    const pGabhs = postTestProb(pre, lr);

    if (pGabhs > 0) {
      out["Faringite estreptocócica (GABHS)"] = pGabhs * 100;
      why["Faringite estreptocócica (GABHS)"] = [
        f.soreThroat ? "odinofagia" : null,
        !f.cough ? "sem tosse" : null,
        f.fever ? "febre" : null,
        tonsilExudate ? "placas/exsudato" : null,
        (age >= 3 && age <= 14) ? "faixa etária pediátrica (McIsaac)" : (age >= 45 ? "idade ≥45 reduz a pontuação" : null),
        parsed?.trajectory === "piorando" ? "trajetória de piora" : null,
      ].filter(Boolean);
    }

    // Mononucleose — apenas sugestivo
    const extremeFatigue = /(cansa[cç]o extremo|exaust[aã]o|muito cansad)/.test(txt);
    const pMono = tonsilExudate && extremeFatigue ? 0.6 : 0.05;
    if (pMono > 0.05) {
      out["Mononucleose infecciosa"] = pMono * 100;
      why["Mononucleose infecciosa"] = ["exsudato + fadiga importante"];
    }

    // Viral = resto
    const pViral = clamp01(1 - clamp01(pGabhs) - clamp01(pMono));
    out["Faringite viral inespecífica"] = Math.max(out["Faringite viral inespecífica"] || 0, pViral * 100);

    // Disfonia/Laringe
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

    const list = toTop3(out).map(item => ({
      ...item,
      whyFor: why[item.dx] || undefined
    }));
    const confidence = list[0]?.probability ?? 0.6;
    return { list, confidence };
  }

  // Ouvido
  function dx_ouvido(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const age = input.age ?? null;
    const out = {};
    const why = {};

    const primaryOtologic = f.hearingLoss || f.earFullness || f.dischargeEar || f.earPain;

    if (primaryOtologic) {
      if (parsed?.durationDays != null && parsed.durationDays > 2 && f.earPain && f.fever) {
        out["Otite média aguda"] = 88;
        why["Otite média aguda"] = ["otalgia + febre", `duração ${Math.round(parsed.durationDays)}d`];
      }
      if (f.itchEar || /puxar.*orelha|dor ao tocar/.test(txt) || /(piscina|mergulho|entrou [áa]gua|nado)/.test(txt)) {
        out["Otite externa aguda"] = Math.max(out["Otite externa aguda"] || 0, 90);
        why["Otite externa aguda"] = ["dor ao toque/puxar", "coceira", "exposição à água/piscina"];
      }
      if (f.earFullness && !f.fever && !f.dischargeEar) {
        out["Disfunção tubária / otite serosa"] = Math.max(out["Disfunção tubária / otite serosa"] || 0, 70);
        why["Disfunção tubária / otite serosa"] = ["plenitude auricular sem febre/secreção"];
      }
      if (!out["Otite externa aguda"] && !out["Otite média aguda"] && !out["Disfunção tubária / otite serosa"]) {
        out["Outra causa otogênica"] = 100;
      }
    } else {
      if (/mastigar|abrir a boca/.test(txt)) {
        out["DTM (ATM)/mastigação – otalgia referida"] = 65;
      } else if (f.soreThroat) {
        out["Origem faríngea (faringite/amigdalite) – otalgia referida"] = 90;
      } else {
        out["Otalgia referida (dental/oral/cervical)"] = 100;
      }
    }

    // Zumbido / perda auditiva
    if (f.tinnitus) {
      if (f.pulsatileTinnitus) {
        out["Zumbido pulsátil (avaliar causas vasculares)"] = 100;
      } else if (f.unilateral && (f.hearingLoss || /s[úu]bita|piorou r[aá]pido/.test(txt))) {
        out["Perda auditiva súbita/assimétrica (prioritário)"] = Math.max(out["Perda auditiva súbita/assimétrica (prioritário)"] || 0, 85);
      } else if (f.hearingLoss) {
        out["Perda auditiva neurossensorial (presbiacusia/ruído)"] = Math.max(out["Perda auditiva neurossensorial (presbiacusia/ruído)"] || 0, 70);
      } else {
        out["Zumbido não pulsátil inespecífico"] = Math.max(out["Zumbido não pulsátil inespecífico"] || 0, 70);
      }
    }

    // Heurísticas por idade
    if (age != null) {
      if (age <= 6) {
        // Crianças pequenas: aumenta chance de OMA
        out["Otite média aguda"] = Math.max(out["Otite média aguda"] || 0, 85);
      }
      if (age >= 60 && f.hearingLoss) {
        out["Perda auditiva neurossensorial (presbiacusia/ruído)"] = Math.max(out["Perda auditiva neurossensorial (presbiacusia/ruído)"] || 0, 80);
      }
    }

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.65;
    return { list, confidence };
  }

  // Nariz
  function dx_nariz(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const age = input.age ?? null;
    const out = {};

    // ABRS (IDSA): dupla piora ou ≥10 dias, febre alta 39 + secreção purulenta
    const dupWorse = parsed?.trajectory === "dupla_piora";
    const longSymptoms = (parsed?.durationDays ?? 0) >= 10;
    const highFever = (parsed?.feverMaxC ?? 0) >= 39;
    const purulentClues = /purul|amarel|esverde/.test(txt) || (f.rhinorrhea && /gross[ao]|espess/.test(txt));

    if ((dupWorse || longSymptoms || (highFever && purulentClues)) && (f.facialPressure || f.nasalObstruction)) {
      out["Rinossinusite bacteriana"] = 75;
    }

    const CRS = (f.nasalObstruction || f.rhinorrhea) && (f.facialPressure || f.smellLoss) && (parsed?.durationDays ?? 0) >= 12*7;
    if (CRS) {
      if (f.smellLoss && /(complet[ao]|sem olfato)/.test(txt)) {
        out["Rinossinusite crônica com polipose"] = 90;
        out["Rinossinusite crônica não poliposa"] = 10;
      } else {
        out["Rinossinusite crônica provável"] = Math.max(out["Rinossinusite crônica provável"] || 0, 75);
      }
    } else if (!out["Rinossinusite bacteriana"]) {
      // Alérgica
      const allergicHints = /coceir|espirr/.test(txt) || (f.rhinorrhea && !f.fever);
      if (allergicHints) {
        out["Rinite alérgica"] = 80;
      }
      // Viral/inespecífica
      if (f.nasalObstruction || f.rhinorrhea || f.facialPressure) {
        out["Rinite inespecífica / resfriado"] = Math.max(out["Rinite inespecífica / resfriado"] || 0, 70);
      }
    }

    // Epistaxe
    if (/sangr|epistax/.test(txt)) {
      out["Epistaxe (sangramento nasal)"] = Math.max(out["Epistaxe (sangramento nasal)"] || 0, 70);
    }

    // Idade: rinite alérgica mais prevalente em jovens/adolescentes
    if (age != null && age <= 25) {
      out["Rinite alérgica"] = Math.max(out["Rinite alérgica"] || 0, 85);
    }

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.6;
    return { list, confidence };
  }

  // Pescoço
  function dx_pescoco(input, parsed) {
    const f = featuresFromInput(input, parsed);
    const txt = norm(input.freeText || "");
    const out = {};

    if (f.neckNodes) {
      if (f.fever || f.soreThroat || f.rhinorrhea) {
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

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.55;
    return { list, confidence };
  }

  // ---------------- Referências (para relatório) ----------------
  const REFERENCES = [
    "IDSA. Clinical Practice Guideline for Acute Bacterial Rhinosinusitis in Children and Adults.",
    "IDSA. Clinical Practice Guideline for Group A Streptococcal Pharyngitis.",
    "AAP/AAO-HNS. Clinical Practice Guideline: Acute Otitis Media.",
    "AAO-HNSF. Clinical Practice Guideline: Dysphonia (Hoarseness).",
    "AAO-HNSF. Clinical Practice Guideline: Sudden Hearing Loss.",
  ];

  // ---------------- API Única ----------------
  function localDifferentials(payload, rules) {
    if (!payload || !payload.domain) {
      return { list: [], confidence: 0, notes: ["domínio ausente"], references: REFERENCES.slice() };
    }

    // Parser clínico + projeção no payload (para backend também aproveitar)
    const parsed = parseClinicalText(payload.freeText || "");
    payload.extras = Object.assign({}, payload.extras || {}, { parsed });
    if (!payload.duration && parsed.durationTextNorm) {
      payload.duration = parsed.durationTextNorm; // normaliza p/ "5d", "2sem", etc.
    }

    // Red flags por texto
    const redFlags = detectRedFlags(payload.freeText);

    // Seleção por domínio
    let base;
    switch (payload.domain) {
      case "garganta": base = dx_garganta(payload, parsed); break;
      case "ouvido":   base = dx_ouvido(payload, parsed);   break;
      case "nariz":    base = dx_nariz(payload, parsed);    break;
      case "pescoco":  base = dx_pescoco(payload, parsed);  break;
      default:
        return { list: [], confidence: 0, notes: ["domínio desconhecido"], references: REFERENCES.slice() };
    }

    // gaps: perguntas e sintomas “desconhecidos” (aqui não usamos rules para validar rótulos)
    const questions = followupQuestions(base.list, payload, parsed);
    const unknownSx = []; // mantemos vazio para não “punir” entrada livre via chaves do app

    return {
      ...base,
      gaps: { questions, unknownSx },
      redFlags,
      references: REFERENCES.slice(),
    };
  }

  // Expor
  if (typeof window !== "undefined") window.localDifferentials = localDifferentials;
  if (typeof module !== "undefined") module.exports = { localDifferentials, parseClinicalText };
})(typeof window !== "undefined" ? window : globalThis);
