// diagnostics.js — Motor local (v4.3) com overlay de DISFONIA
// - Compatível com app-ui.js e robotto.js atuais.
// - Usa rules_otorrino.json quando disponível.
// - Adiciona aliases e heurística mínima para "rouco/sem voz" (disfonia).

(function () {
  // -----------------------
  // Utilidades
  // -----------------------
  function clamp(x, a, b) {
    var n = Number(x);
    if (!isFinite(n)) n = a;
    if (n < a) n = a;
    if (n > b) n = b;
    return n;
  }
  function toNum(x, d) {
    if (d === void 0) d = 0;
    var n = Number(x);
    return isFinite(n) ? n : d;
  }
  function norm(s) {
    return (s == null ? "" : String(s)).toLowerCase().trim();
  }

  // -----------------------
  // Referências (livro)
  // -----------------------
  var ENT_LARYNX = "CURRENT Oto-HNS 3e — Larynx/Hypopharynx & Voice";
  var DX_TO_ENT_BOOK = {
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
    "Sialadenite/sialolitíase": ["CURRENT Oto-HNS 3e — Salivary Glands"],
    // Overlays de disfonia:
    "Disfonia aguda (laringite/uso vocal)": [ENT_LARYNX],
    "Disfonia crônica (investigar LPR/nódulos/paralisia/lesão)": [ENT_LARYNX]
  };

  // -----------------------
  // Duração → dias
  // -----------------------
  function parseDurationDays(payload) {
    if (payload && payload.extras && payload.extras.parsed && payload.extras.parsed.durationDays != null) {
      return payload.extras.parsed.durationDays;
    }
    var d = String((payload && (payload.duration || payload.duration_norm)) || "").toLowerCase();

    // ISO8601 simplificado: PnM nW nD
    var m = d.match(/^p(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?$/i);
    if (m) {
      var months = m[1] ? +m[1] : 0;
      var weeks = m[2] ? +m[2] : 0;
      var days = m[3] ? +m[3] : 0;
      return months * 30 + weeks * 7 + days;
    }
    // PTnH
    var mh = d.match(/^pt(\d+)h$/i);
    if (mh) return Math.max(0.04, (+mh[1]) / 24);

    // Livre (ex.: 10 dias, 2 semanas, 1 mês, 12h)
    var m2 = d.match(/(\d+)\s*(h|hora|horas|d|dia|dias|sem|semanas|m|mes|meses)/);
    if (m2) {
      var n = +m2[1];
      var u = m2[2];
      if (/^h/.test(u)) return Math.max(0.04, n / 24);
      if (/^d|dia/.test(u)) return n;
      if (/^sem/.test(u)) return n * 7;
      if (/^m|mes/.test(u)) return n * 30;
    }
    return null;
  }

  // -----------------------
  // Aliases (rules + garantias)
  // -----------------------
  function buildReverseAliases(rules) {
    var rev = {};
    var aliases = rules && rules.logic && rules.logic.symptom_aliases ? rules.logic.symptom_aliases : {};
    Object.keys(aliases).forEach(function (canon) {
      rev[canon] = canon;
      (aliases[canon] || []).forEach(function (a) { rev[a] = canon; });
    });

    // Garantias para disfonia
    var dysCanon = "disfonia";
    [
      "rouquidao", "rouquidão", "rouco", "voz_rouca",
      "sem_voz", "afonia", "semvoz", "perda_da_voz", "voz_falhando", "disfonia"
    ].forEach(function (a) { if (!rev[a]) rev[a] = dysCanon; });
    if (!rev[dysCanon]) rev[dysCanon] = dysCanon;

    return rev;
  }

  function normalizeSymptoms(uiSymptoms, revAliases) {
    var set = new Set();
    (uiSymptoms || []).forEach(function (k) {
      var k0 = norm(k);
      var std = revAliases[k0] || k0;
      set.add(std);

      // expansões simples
      if (std === "coriza") set.add("rinorreia");
      if (std === "nariz_entupido") set.add("obstrucao_nasal");
      if (std === "dor_de_garganta") set.add("odinofagia");
      if (std === "dor_de_ouvido") set.add("otalgia");
      if (std === "secrecao_otica") set.add("otorreia");
      if (std === "reducao_olfato") set.add("hiposmia");
      if (std === "dificuldade_de_ouvir") set.add("hipoacusia");
      if (std === "pressao_na_face") set.add("pressao_facial");
      if (std === "mau_cheiro") set.add("cacosmia");

      // rota para disfonia
      if (["rouquidao","rouquidão","rouco","voz_rouca","sem_voz","afonia","semvoz","perda_da_voz","voz_falhando"].indexOf(std) >= 0) {
        set.add("disfonia");
      }
    });
    return set;
  }

  // -----------------------
  // Domínio por texto
  // -----------------------
  function inferDomainFromText(t) {
    var s = (t || "").toLowerCase();
    if (/ouvid|otalg|otite|timp|orelha/.test(s)) return "ouvido";
    if (/nariz|rin(i|o)|sinus|seio.*face|rinossinus|epistax/.test(s)) return "nariz";
    if (/gargant|faring|larin|amigdal|odinofag|voz|rouquid/.test(s)) return "garganta";
    if (/pescoc|cervic|linfon|n[oó]dul|caro[cç]o/.test(s)) return "pescoco";
    return "garganta";
  }

  // -----------------------
  // Cálculo principal
  // -----------------------
  function computeDxScores(payload, rules) {
    var text = (payload && (payload.freeTextOriginal || payload.freeText)) || "";
    var domain = payload && payload.domain ? payload.domain : inferDomainFromText(text);
    if (!domain) domain = "garganta";

    var block = rules && rules.domains && rules.domains[domain] ? rules.domains[domain] : null;
    if (!block || !Array.isArray(block.dx)) return [];

    var revAliases = buildReverseAliases(rules);
    var sxSet = normalizeSymptoms(payload && payload.symptoms, revAliases);

    var durationDays = parseDurationDays(payload);
    var age = payload && payload.age != null ? toNum(payload.age, null) : null;
    var tmax = payload && payload.fever_max_c != null ? toNum(payload.fever_max_c, null) : null;
    var traj = payload && payload.trajectory ? payload.trajectory : null;
    var negsArr = (payload && payload.negations) ? payload.negations : [];
    var negs = new Set(negsArr.map(norm));

    var K = 0.25;
    var out = [];

    block.dx.forEach(function (d) {
      var prior = clamp(toNum(d.prior, 0.2), 0.01, 0.95);
      var score = prior;

      var sw = d.symptom_weights || {};
      Object.keys(sw).forEach(function (k) {
        if (sxSet.has(k)) score += K * toNum(sw[k], 0);
      });

      var md = d.modifiers || {};

      if (Array.isArray(md.age) && age != null) {
        md.age.forEach(function (rule) {
          var gteOk = (rule.gte == null) || (age >= rule.gte);
          var lteOk = (rule.lte == null) || (age <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (Array.isArray(md.duration_days) && durationDays != null) {
        md.duration_days.forEach(function (rule) {
          var gteOk = (rule.gte == null) || (durationDays >= rule.gte);
          var lteOk = (rule.lte == null) || (durationDays <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (Array.isArray(md.trajectory) && traj) {
        md.trajectory.forEach(function (rule) {
          var match = String(rule.is || "").toLowerCase() === String(traj).toLowerCase();
          var minD = toNum(rule.min_duration_days, null);
          if (match && (minD == null || (durationDays != null && durationDays >= minD))) {
            score += toNum(rule.boost, 0);
          }
        });
      }
      if (Array.isArray(md.fever_max_c) && tmax != null) {
        md.fever_max_c.forEach(function (rule) {
          var gteOk = (rule.gte == null) || (tmax >= rule.gte);
          var lteOk = (rule.lte == null) || (tmax <= rule.lte);
          if (gteOk && lteOk) score += toNum(rule.boost, 0);
        });
      }
      if (md.negations && typeof md.negations === "object") {
        Object.keys(md.negations).forEach(function (negKey) {
          var boost = toNum(md.negations[negKey], 0);
          if (negs.has(negKey) || negs.has("sem_" + negKey)) score += boost;
        });
      }

      score = clamp(score, 0.001, 0.999);
      out.push({
        dx: d.name,
        score: score,
        source: d.source || null
      });
    });

    // Overlay de DISFONIA
    applyDysphoniaOverlay(out, {
      sxSet: sxSet,
      durationDays: durationDays,
      age: age
    });

    // Normalização → probabilidades
    var sum = out.reduce(function (a, b) { return a + b.score; }, 0);
    if (!sum) sum = 1;
    out.forEach(function (o) { o.probability = clamp(o.score / sum, 0, 1); });
    out.sort(function (a, b) { return b.probability - a.probability; });
    return out;
  }

  function applyDysphoniaOverlay(list, ctx) {
    var sxSet = ctx && ctx.sxSet ? ctx.sxSet : new Set();
    var hasDys = sxSet.has("disfonia");
    if (!hasDys) return;

    var durationDays = ctx.durationDays;
    var age = ctx.age;

    if (durationDays == null || durationDays < 21) {
      list.push({
        dx: "Disfonia aguda (laringite/uso vocal)",
        score: 0.35,
        source: ENT_LARYNX
      });
    } else {
      list.push({
        dx: "Disfonia crônica (investigar LPR/nódulos/paralisia/lesão)",
        score: 0.40,
        source: ENT_LARYNX
      });
      if (age != null && age >= 60) {
        list.push({
          dx: "Atenção: disfonia crônica em idoso — avaliar neoplasia laríngea",
          score: 0.15,
          source: ENT_LARYNX
        });
      }
    }
  }

  // -----------------------
  // Perguntas / gaps
  // -----------------------
  function dedup(arr) {
    var s = new Set();
    var out = [];
    (arr || []).forEach(function (x) {
      if (!s.has(x)) { s.add(x); out.push(x); }
    });
    return out;
  }

  function buildGaps(payload) {
    var qs = [];
    var sxSet = new Set(((payload && payload.symptoms) || []).map(norm));
    var negs = new Set(((payload && payload.negations) || []).map(norm));

    if (!(payload && (payload.duration || payload.duration_norm))) {
      qs.push("Há quantos dias os sintomas começaram?");
    }
    if (!(payload && payload.trajectory)) {
      qs.push("Desde o início, os sintomas estão piorando?");
    }

    var ft = String((payload && payload.freeTextOriginal) || "");
    var hasFebre = sxSet.has("febre") || negs.has("febre") || /afebril/.test(ft);
    if (payload && payload.fever_max_c == null && !hasFebre) {
      qs.push("Você teve febre?");
    }

    var dom = payload && payload.domain ? payload.domain : null;
    if (dom === "nariz") {
      qs.push("Houve 'dupla piora' após alguma melhora?");
    }
    if (dom === "garganta") {
      qs.push("Você tem placas ou exsudato nas amígdalas?");
      if (!(negs.has("tosse") || /sem\s+tosse/i.test(ft))) {
        qs.push("Você tem tosse?");
      }
    }
    if (dom === "ouvido") {
      qs.push("Tocar/puxar o pavilhão auricular aumenta a dor?");
      qs.push("Sai secreção pelo ouvido?");
    }

    // Disfonia
    var hasDys = sxSet.has("disfonia") || /rouquid[aã]o|afonia|sem\s*voz|voz\s*rouca/i.test(ft);
    if (hasDys) {
      qs.push("Sua rouquidão dura há mais de 3 semanas?");
    }

    return { questions: dedup(qs).slice(0, 3) };
    // mantemos no máximo 3 para o bot ficar ágil
  }

  // -----------------------
  // Confiança simples
  // -----------------------
  function estimateConfidence(list, payload) {
    if (!list || !list.length) return 0.5;
    var top = list[0].probability || 0;
    var second = list[1] ? (list[1].probability || 0) : 0;
    var sep = Math.max(0, top - second);

    var signals = 0;
    if (payload && payload.symptoms && payload.symptoms.length) signals += Math.min(3, payload.symptoms.length);
    if (payload && payload.fever_max_c != null) signals += 1;
    if (payload && payload.trajectory) signals += 1;
    if (payload && (payload.duration || payload.duration_norm)) signals += 1;

    var hasDys = (payload && payload.symptoms || []).some(function (s) { return norm(s) === "disfonia"; });
    if (hasDys) signals += 0.5;

    var base = 0.45 + 0.08 * signals + 0.25 * sep;
    return clamp(base, 0.3, 0.95);
  }

  // -----------------------
  // API pública
  // -----------------------
  function localDifferentials(payload, rules) {
    var r = rules || {};
    var list = computeDxScores(payload || {}, r);
    var top3 = list.slice(0, 3).map(function (d) {
      return { dx: d.dx, probability: d.probability };
    });
    var confidence = estimateConfidence(list, payload);
    var gaps = buildGaps(payload);

    // referências
    var refsFromRules = [];
    var domain = (payload && payload.domain) ? payload.domain : inferDomainFromText((payload && (payload.freeText || payload.freeTextOriginal)) || "");
    var dxBlock = r && r.domains && r.domains[domain] ? (r.domains[domain].dx || []) : [];
    var nameToSource = {};
    dxBlock.forEach(function (x) { nameToSource[String(x.name)] = x.source || null; });
    list.forEach(function (d) {
      var src = nameToSource[d.dx];
      if (src) refsFromRules.push(String(src));
    });

    var refsFromBook = [];
    list.forEach(function (d) {
      if (DX_TO_ENT_BOOK[d.dx]) {
        DX_TO_ENT_BOOK[d.dx].forEach(function (s) { refsFromBook.push(s); });
      }
    });

    var references = dedup(refsFromRules.concat(refsFromBook));

    return { list: list, top3: top3, confidence: confidence, gaps: gaps, references: references };
  }

  // Exposição global
  window.localDifferentials = localDifferentials;
})();
