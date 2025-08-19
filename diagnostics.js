/* diagnostics.js (v2 com follow-ups)
   Predição local (Top-3) para OUVIDO / NARIZ / GARGANTA / PESCOCO.
   Integra heurísticas bayesianas/experts + insumos do rules_otorrino.json.

   API (compatível):
     localDifferentials(payload, rules) -> {
       list: [{ dx, probability: 0..1, whyFor?: string[], whyAgainst?: string[] }],
       confidence: 0..1,
       gaps?: { questions?: string[], unknownSx?: string[] },
       redFlags?: { any: boolean, patterns?: string[] },
       notes?: string[]
     }

   payload esperado:
     {
       domain: "ouvido"|"nariz"|"garganta"|"pescoco",
       age: number|null,
       sex: "M"|"F"|"OUTRO"|null,
       duration: string|null,
       symptoms: string[],   // labels exatamente como aparecem nas choices do rules
       freeText: string,
       extras?: object       // para inputs guiados (ex.: vertigem: timing/trigger)
     }
*/

(function (global) {
  // ---------------- Utils ----------------
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const pct = (v) => Math.round(clamp01(v) * 100);
  const norm = (s) => (s || "").toLowerCase();

  function toTop3(obj) {
    const arr = Object.entries(obj).map(([dx, p]) => ({ dx, probability: clamp01((+p || 0) / 100) }));
    arr.sort((a, b) => b.probability - a.probability);
    return arr.slice(0, 3);
  }

  function hasSym(symptoms, label) {
    const L = norm(label);
    return (symptoms || []).some((s) => norm(s) === L);
  }

  function uniq(arr) {
    return Array.from(new Set(arr || []));
  }

  // Bayes simples para testes diagnósticos (ex.: Centor/McIsaac p/ GABHS)
  function postTestProb(pre, lr) {
    pre = clamp01(pre);
    if (pre >= 1) return 1;
    const odds = pre / (1 - pre);
    const postOdds = odds * lr;
    return postOdds / (1 + postOdds);
  }

  // Red flags (texto livre)
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
  const RulesMapper = {
    // Tenta localizar um label no rules (case-insensitive). Fallback: usa o que veio do payload.
    normalizeSymptom(sym, rules) {
      if (!rules || !rules.intake || !rules.intake.sections) return sym;
      const L = norm(sym);
      for (const sec of Object.values(rules.intake.sections)) {
        if (!sec || !sec.choices) continue;
        for (const c of sec.choices) {
          if (norm(c.label) === L) return c.label; // retorna o label “oficial” do rules
        }
      }
      return sym;
    },

    // Conjunto de labels “oficiais” (para detectar unknownSx)
    labelsSet(rules) {
      const S = new Set();
      try {
        for (const sec of Object.values(rules?.intake?.sections || {})) {
          for (const c of (sec?.choices || [])) S.add(norm(c.label));
        }
      } catch {}
      return S;
    },

    // Extrai features de interesse a partir do checklist + texto
    featuresFrom({ symptoms = [], freeText = "" }, rules) {
      const t = norm(freeText);
      const get = (want) =>
        hasSym(
          symptoms.map((s) => this.normalizeSymptom(s, rules)),
          want
        );

      return {
        // sinais gerais
        fever: get("Febre") || /\b(febre|febril)\b/.test(t),
        cough: get("Tosse"),
        soreThroat: get("Dor de Garganta") || /\bdor de garganta|odinof[aá]gia\b/.test(t),
        nasalObstruction: get("Nariz entupido"),
        rhinorrhea: get("Coriza ou Catarro"),
        facialPressure: get("Pressão na face") || /\b(dor|press[aã]o) (facial|na face)\b/.test(t),
        smellLoss: get("Redução do Olfato") || /\b(anosmia|sem olfato)\b/.test(t),
        tasteLoss: get("Redução do Paladar"),
        earPain: get("Dor de Ouvido") || /otalgia|dor.*ouvido/.test(t),
        earFullness: get("Sensação de ouvido tapado"),
        hearingLoss: get("Dificuldade de ouvir") || /\bhipoacusia|ou[cç]o pior\b/.test(t),
        itchEar: get("Coceira no ouvido"),
        tinnitus: get("Zumbido"),
        dizziness: get("Tontura"),
        presyncope: get("Sensação de Desmaio"),
        halitosis: get("Mau Hálito"),
        globus: get("Sensação de Bolo na garganta"),
        dysphagia: get("Dificuldade ou Desconforto para engolir"),
        neckNodes: get("Aumento dos gânglios do pescoço") || /g[âa]nglios|caro[cç]o no pesco[cç]o/.test(t),
        snoring: get("Roncos"),

        // heurísticas de texto livre
        dischargeEar: /secre[cç][aã]o|pus.*ouvido/.test(t),
        afterPool: /(piscina|mergulho|entrou [áa]gua|nado)/.test(t),
        unilateral: /(um lado|lateral|s[óo] no direito|s[óo] no esquerdo)/.test(t),
        pulsatileTinnitus: /(puls[aá]til|bate|batimento).*(zumbido|ouvido)/.test(t),
      };
    },
  };

  // ---------------- Geração de follow-ups (gaps.questions) ----------------
  function followupQuestions(top3, input, rules) {
    const qs = [];
    const t = norm(input.freeText || "");
    const add = (q) => { if (q && !qs.includes(q)) qs.push(q); };

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
        add("Teve febre nas últimas 24–48h?");
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
        add("O zumbido parece acompanhar batimentos do coração (pulsátil)?");
        add("O zumbido é em um lado só?");
      }

      // NARIZ
      if (name.includes("rinossinusite crônica")) {
        add("Há quanto tempo os sintomas persistem (semanas/meses)?");
        add("Percebe descarga nasal purulenta ou pressão que piora ao abaixar a cabeça?");
        add("Teve redução importante do olfato?");
      }
      if (name.includes("rinite al")) {
        add("Tem coceira no nariz/olhos e espirros em salva?");
        add("Os sintomas pioram em épocas específicas (sazonal)?");
      }
      if (name.includes("rinite inespec") || name.includes("resfriado")) {
        add("Há febre alta ou piora após 5–7 dias de sintomas?");
      }
      if (name.includes("epistaxe")) {
        add("O sangramento foi unilateral e durou mais de 10 minutos?");
        add("Usa anticoagulantes ou antiagregantes?");
      }

      // GARGANTA
      if (name.includes("faringite estrept") || name.includes("gabhs")) {
        add("Existe pus/placa nas amígdalas?");
        add("Está sem tosse e com febre?");
        add("Início da dor foi rápido e é intensa ao engolir?");
      }
      if (name.includes("faringite viral")) {
        add("Há sintomas de resfriado (nariz entupido/coriza/tosse)?");
      }
      if (name.includes("mononucleose")) {
        add("Sente cansaço extremo ou linfonodos inchados?");
      }
      if (name.includes("disfonia") || name.includes("rouquid")) {
        add("Há quanto tempo está rouco(a)? Passa de 3–4 semanas?");
        add("Fuma ou tem exposição ocupacional à poeira/químicos?");
      }

      // PESCOÇO
      if (name.includes("linfadenite") || name.includes("linfadenop")) {
        add("O caroço no pescoço é doloroso ao toque?");
        add("Há febre, perda de peso ou suores noturnos?");
        add("Há quanto tempo o gânglio está aumentado?");
      }
    }

    // Fallback genérico se nada foi detectado
    if (qs.length === 0) {
      add("Quando os sintomas começaram e como evoluíram desde então?");
      add("Alguma coisa piora ou alivia os sintomas?");
      add("Teve febre, secreções ou dor muito intensa?");
    }

    return qs.slice(0, 6);
  }

  // ---------------- Módulos por domínio ----------------

  // Garganta
  function dx_garganta(input, rules) {
    const f = RulesMapper.featuresFrom(input, rules);
    const age = input.age ?? 30;
    const txt = norm(input.freeText || "");
    const out = {};

    // Centor/McIsaac simplificado
    let score = 0;
    if (f.fever) score += 1;
    if (!f.cough) score += 1;
    if (f.neckNodes) score += 1;
    const tonsilExudate = f.soreThroat && /(pus|placa|exsudat)/.test(txt);
    if (tonsilExudate) score += 1;

    let pre = 0.10;
    if (age >= 3 && age <= 14) { score += 1; pre = 0.25; }
    else if (age >= 45) { score -= 1; pre = 0.10; }

    const lrMap = { "-1": 0.16, "0": 0.16, "1": 0.3, "2": 0.75, "3": 2.1, "4": 6.3, "5": 6.3 };
    const lr = lrMap[String(score)] ?? 0.75;
    const pGabhs = postTestProb(pre, lr);

    // Mononucleose
    const extremeFatigue = /(cansa[cç]o extremo|exaust[aã]o|muito cansad)/.test(txt);
    const pMono = tonsilExudate && extremeFatigue ? 0.7 : 0.05;

    // Viral = resto
    const pViral = clamp01(1 - pGabhs - pMono);

    out["Faringite estreptocócica (GABHS)"] = pGabhs * 100;
    out["Mononucleose infecciosa"] = pMono * 100;
    out["Faringite viral inespecífica"] = pViral * 100;

    // Disfonia/rouquidão
    if (/rouquid[aã]o|disfonia|voz rouca|voz cansada/.test(txt)) {
      const weeks = /(\d+)\s*semana/.test(input.duration || "") ? parseInt(RegExp.$1, 10) : null;
      if (/sangue na saliva|perda de peso|caro[cç]o no pesco[cç]o/.test(txt)) {
        out["Sinal de alarme (excluir neoplasia de laringe)"] = 100;
      } else if (weeks !== null && weeks >= 4) {
        out["Disfonia crônica (avaliar laringe)"] = Math.max(out["Disfonia crônica (avaliar laringe)"] || 0, 60);
      } else {
        out["Laringite aguda (viral/uso de voz)"] = Math.max(out["Laringite aguda (viral/uso de voz)"] || 0, 60);
      }
    }

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.6;
    return { list, confidence };
  }

  // Ouvido
  function dx_ouvido(input, rules) {
    const f = RulesMapper.featuresFrom(input, rules);
    const txt = norm(input.freeText || "");
    const out = {};

    const primaryOtologic = f.hearingLoss || f.earFullness || f.dischargeEar || f.earPain;

    if (primaryOtologic) {
      if (f.afterPool || f.itchEar || /puxar.*orelha|dor ao tocar/.test(txt)) {
        out["Otite externa aguda"] = 90;
        out["Outras causas otogênicas"] = 10;
      } else if (f.fever && (/grip|resfri|infec[cç][aã]o respirat[óo]ria/.test(txt) || f.rhinorrhea)) {
        out["Otite média aguda"] = 85;
        out["Outras causas otogênicas"] = 15;
      } else if (f.earFullness) {
        out["Disfunção tubária / otite serosa"] = 70;
        out["Outras causas otogênicas"] = 30;
      } else {
        out["Outra causa otogênica"] = 100;
      }
    } else {
      if (/mastigar|abrir a boca/.test(txt)) {
        out["DTM (ATM)/mastigação – otalgia referida"] = 60;
        out["Otalgia referida inespecífica"] = 40;
      } else if (f.soreThroat) {
        out["Origem faríngea (faringite/amigdalite) – otalgia referida"] = 95;
        out["Outras"] = 5;
      } else {
        out["Otalgia referida (dental/oral/cervical)"] = 100;
      }
    }

    // Zumbido/PA súbita
    if (f.tinnitus) {
      if (f.pulsatileTinnitus) {
        out["Zumbido pulsátil (avaliar causas vasculares)"] = 100;
      } else if (f.unilateral && (f.hearingLoss || /s[úu]bita|piorou r[aá]pido/.test(txt))) {
        out["Perda auditiva súbita/assimétrica (prioritário)"] = Math.max(
          out["Perda auditiva súbita/assimétrica (prioritário)"] || 0,
          80
        );
      } else if (f.hearingLoss) {
        out["Perda auditiva neurossensorial (presbiacusia/ruído)"] = Math.max(
          out["Perda auditiva neurossensorial (presbiacusia/ruído)"] || 0,
          70
        );
      } else {
        out["Zumbido não pulsátil inespecífico"] = Math.max(out["Zumbido não pulsátil inespecífico"] || 0, 70);
      }
    }

    // Vertigem (compacto)
    if (f.dizziness) {
      out["Vertigem periférica provável (VPPB/Menière/neurite)"] = Math.max(
        out["Vertigem periférica provável (VPPB/Menière/neurite)"] || 0,
        70
      );
    }

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.65;
    return { list, confidence };
  }

  // Nariz
  function dx_nariz(input, rules) {
    const f = RulesMapper.featuresFrom(input, rules);
    const txt = norm(input.freeText || "");
    theOut = {};
    const out = theOut;

    const allergicHints = /coceir|espirr/.test(txt) || (f.rhinorrhea && !f.fever);
    const CRS = (f.nasalObstruction || f.rhinorrhea) && (f.facialPressure || f.smellLoss);

    if (CRS) {
      if (f.smellLoss && /(complet[ao]|sem olfato)/.test(txt)) {
        out["Rinossinusite crônica com polipose"] = 90;
        out["Rinossinusite crônica não poliposa"] = 10;
      } else {
        out["Rinossinusite crônica provável"] = 75;
        out["Rinite inespecífica"] = 25;
      }
    } else if (allergicHints) {
      out["Rinite alérgica"] = 85;
      out["Rinite inespecífica"] = 15;
    } else if (f.nasalObstruction || f.rhinorrhea || f.facialPressure) {
      out["Rinite inespecífica / resfriado"] = 80;
      out["Outras causas"] = 20;
    }

    if (/sangr|epistax/.test(txt)) {
      out["Epistaxe (sangramento nasal)"] = Math.max(out["Epistaxe (sangramento nasal)"] || 0, 70);
    }

    const list = toTop3(out);
    const confidence = list[0]?.probability ?? 0.6;
    return { list, confidence };
  }

  // Pescoço
  function dx_pescoco(input, rules) {
    const f = RulesMapper.featuresFrom(input, rules);
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

  // ---------------- API Única ----------------
  function localDifferentials(payload, rules) {
    const domain = payload?.domain;
    if (!domain) return { list: [], confidence: 0, notes: ["domínio ausente"] };

    let base;
    switch (domain) {
      case "garganta": base = dx_garganta(payload, rules); break;
      case "ouvido":   base = dx_ouvido(payload, rules);   break;
      case "nariz":    base = dx_nariz(payload, rules);    break;
      case "pescoco":  base = dx_pescoco(payload, rules);  break;
      default:
        return { list: [], confidence: 0, notes: ["domínio desconhecido"] };
    }

    // gaps.unknownSx
    const official = RulesMapper.labelsSet(rules);
    const unknownSx = (payload?.symptoms || [])
      .filter(s => !official.has(norm(RulesMapper.normalizeSymptom(s, rules))));

    // gaps.questions
    const questions = followupQuestions(base.list, payload, rules);

    // red flags (texto)
    const redFlags = detectRedFlags(payload?.freeText);

    return {
      ...base,
      gaps: { questions, unknownSx },
      redFlags
    };
  }

  // Expor
  if (typeof window !== "undefined") window.localDifferentials = localDifferentials;
  if (typeof module !== "undefined") module.exports = { localDifferentials };
})(typeof window !== "undefined" ? window : globalThis);
// Fim do módulo diagnostics.js
// ---------------- Fim do módulo diagnostics.js ----------------