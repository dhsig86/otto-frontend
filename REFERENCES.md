# REFERÊNCIAS (Base ENT)

Este projeto usa literatura técnica para fundamentar regras locais e para auditoria/validação clínica.

## Obra de referência geral
- **CURRENT Diagnosis & Treatment in Otolaryngology – Head & Neck Surgery. 3rd ed.** Lalwani AK (ed.). McGraw-Hill; 2012.  
  (Referida no código como “CURRENT Oto-HNS 3e”.)

## Mapeamento por domínio/diagnóstico
- **Nariz / Seios da face**
  - Rinossinusite viral/bacteriana → CURRENT Oto-HNS 3e, *Cap. 15: Acute & Chronic Sinusitis*
  - Rinite alérgica → *Cap. 14: Rhinitis*
- **Ouvido**
  - Otite Externa Aguda → *Cap. 47: Diseases of the External Ear*
  - Otite Média Aguda → *Cap. 49: Otitis Media*
  - Tampão de cerume → *Cap. 47: External Ear (Cerumen)*
- **Garganta / Orofaringe / Laringe**
  - Faringoamigdalite viral / Amigdalite estreptocócica → *Cap. 31: Oropharynx & Tonsil*
  - DRGE/LPR (refluxo laringofaríngeo) → *Caps. 30–31: Larynx & Hypopharynx / Oropharynx*
- **Pescoço / Glândulas salivares**
  - Linfadenite reacional / massas cervicais → *Cap. 27: Neck Masses*
  - Sialadenite / Sialolitíase → *Caps. 18–19: Salivary Glands*
- **Vestibular (para expansões futuras)**
  - Vertigens (BPPV, Ménière, neurite) → *Cap. 56: Vestibular Disorders*

> Sempre que um diagnóstico for exibido, o relatório pode incluir a referência do capítulo correspondente. O backend pode somar outras fontes (IDSA, AAFP etc.).

## Como o app usa estas referências
- **rules_otorrino.json**: cada diagnóstico contém um campo `source` com diretrizes principais e o capítulo do CURRENT Oto-HNS 3e.
- **diagnostics.js**: o motor local agrega automaticamente as referências dos diagnósticos ranqueados em `local.references`.
- **robotto.js / app-ui.js**: quando o backend enviar `references[]`, elas aparecem no relatório; caso contrário, entram as referências do motor local.
