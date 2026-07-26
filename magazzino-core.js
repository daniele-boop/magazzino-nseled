/**
 * magazzino-core.js — MOTORE CONDIVISO del magazzino NSELED
 * ---------------------------------------------------------------------------
 * Contiene SOLO logica pura: nessuna grafica, nessun accesso al DOM.
 * Legge le righe del foglio, le trasforma in categorie/articoli, e (Tappa 2)
 * calcolerà la disponibilità dei ledwall completi da cabinet + moduli.
 *
 * Lo usano SIA la dashboard team (index.html) SIA l'area riservata (admin.html):
 * così le regole di parsing/batch/distinta base si programmano UNA volta sola.
 *
 * Espone: window.NSEMag
 */
window.NSEMag = (function () {

  // Prima categoria-etichetta che apre la sezione Ricambi/Moduli.
  // Tutto ciò che nel foglio viene da qui in giù finisce nei Ricambi.
  const INIZIO_RICAMBI = 'LEDWALL INDOOR MODULI LED';

  // Voci da NON mostrare: parole di stato o note finite nella colonna del codice
  // (non sono veri articoli). Confronto esatto in maiuscolo.
  const IGNORE = new Set([
    'NUOVO', 'USATO', 'NOLEGGIO', 'RESO', 'SOSTITUZIONE',
    'EX SHOWROOM', 'SHOWROOM', 'EX DEMO', 'DEMO',
    'MANCANO VENTOLE', 'BASI PICCOLE'
  ]);

  // Legge il valore di una cella nel formato gviz / Apps Script ({v} oppure {f}).
  function gv(c) {
    if (!c) return '';
    return (c.f != null) ? String(c.f) : (c.v != null ? String(c.v) : '');
  }

  // ---------------------------------------------------------------------------
  // parseSheet(table) → array ordinato di categorie, ognuna con le sue batch.
  // FUNZIONE PURA: restituisce il risultato, non tocca DOM né variabili esterne.
  // ---------------------------------------------------------------------------
  function parseSheet(table) {
    const rows = (table && table.rows) || [];
    const groups = [];               // categorie nell'ordine del foglio
    const catByKey = new Map();       // dedup categorie (per codice o per nome contenitore)
    let current = null;               // categoria aperta
    let inSpare = false;

    rows.forEach((row, idx) => {
      if (!row || !row.c) return;
      const rowNum = idx + 1;
      const b = gv(row.c[1]).trim();
      const c = gv(row.c[2]).trim();
      const d = gv(row.c[3]).trim();
      const e = gv(row.c[4]).trim();
      const f = gv(row.c[5]).trim();

      if (!b && !c && !d && !e && !f) return;

      const mkCat = (name, code, isHeader) => {
        const cat = {
          name: (name || code || '—'),
          code: (code || ''),
          isHeader,
          row: rowNum,
          section: (inSpare || /^MOD-/i.test(code || '')) ? 'spare' : 'prod',
          batches: []
        };
        groups.push(cat);
        return cat;
      };

      const dl = d.toLowerCase();

      // Riga di INTESTAZIONE categoria (D = "Condizione")
      if (dl === 'condizione' || dl === 'quantità' || dl === 'quantita') {
        // Etichetta colonne globale (ARTICOLO): intestazione del foglio, non una categoria.
        if (b.toUpperCase() === 'ARTICOLO') { current = null; return; }
        // Etichetta vuota senza nome: divisore tecnico, da saltare.
        if (!b && c.toUpperCase() === 'CODICE') { current = null; return; }

        // Da qui in poi è sezione ricambi se questa testata è la categoria di confine.
        if (b.toUpperCase().includes(INIZIO_RICAMBI.toUpperCase())) inSpare = true;

        // Una testata può essere:
        //  - categoria-prodotto con codice proprio (es. "Totem P3 INDOOR" / TTI305719)
        //  - categoria-contenitore (es. "RENTAL", "VIDEO PROCESSORI") con C = "CODICE"
        const isContainer = (c.toUpperCase() === 'CODICE');
        const key = isContainer ? ('@' + b.toUpperCase()) : (c || b).toUpperCase();
        if (catByKey.has(key)) {
          current = catByKey.get(key);            // stessa categoria spezzata nel foglio: unisci
        } else {
          current = mkCat(b || c, isContainer ? '' : c, true);
          catByKey.set(key, current);
        }
        return;
      }

      // Riga di magazzino valida (quantità numerica o condizione riconosciuta)
      const qtyNum = parseFloat((f || '').replace(',', '.'));
      const hasQty = (f !== '' && !isNaN(qtyNum));
      const hasCond = /nuovo|usato|noleggio|reso|showroom/i.test(d);
      if (!hasQty && !hasCond) return;
      const qty = hasQty ? qtyNum : 0;
      if (!b && !hasCond && qty === 0) return;   // salta i separatori vuoti

      const batch = { bn: b, code: c, cond: d, loc: e, qty };

      if (current) {
        // Tutte le righe appartengono alla categoria aperta (come nel foglio)
        current.batches.push(batch);
      } else if (c) {
        // Nessuna categoria attiva: raggruppo per codice (caso di sicurezza)
        const key = c.toUpperCase();
        let cat = catByKey.get(key);
        if (!cat) { cat = mkCat(c, c, false); catByKey.set(key, cat); }
        current = cat;
        cat.batches.push(batch);
      }
    });

    return groups.filter(g =>
      g.batches.length > 0 &&
      !IGNORE.has((g.code || '').toUpperCase().trim()) &&
      !IGNORE.has((g.name || '').toUpperCase().trim())
    );
  }

  // ===========================================================================
  // TAPPA 2 — Calcolo disponibilità ledwall completi (cabinet + moduli, batch-aware)
  // Modello DATA-DRIVEN: la distinta base vive in due tabelle qui sotto, non nel
  // codice. Aggiungere/correggere una serie = toccare SOLO le tabelle.
  // ===========================================================================

  // Sigla passo (2 cifre nel codice) → passo reale.
  const PASSO = {
    '12':'1.25','15':'1.53','16':'1.667','18':'1.86','19':'1.953','20':'2.0',
    '25':'2.5','26':'2.604','29':'2.976','30':'3.076','39':'3.91','40':'4.0','48':'4.8'
  };
  // Sigle LWI che appartengono alla famiglia 320×160 (le altre LWI → 250×250).
  const SIGLE_320 = new Set(['12','15','16','18','20','25','30','40']);

  // Codice dimensione (2 cifre) → mm. Famiglia 250×250 usa moduli 250×250, quindi
  // moduli per lato = mm/250. Vale per LWI (1050=1000×500) e rental verticale
  // (5010=500×1000): conta l'area, il risultato è lo stesso.
  const DIMMM = { '10':1000, '25':250, '50':500 };
  function moduli250(dim4){ const a=DIMMM[dim4.slice(0,2)], b=DIMMM[dim4.slice(2,4)]; return (a&&b)?(a/250)*(b/250):null; }
  function fmtDim(dim4){ const a=DIMMM[dim4.slice(0,2)], b=DIMMM[dim4.slice(2,4)]; return (a&&b)?(a+'×'+b):dim4; }

  // Distinta base esplicita per le famiglie a modulo NON quadrato.
  const MOD320  = { '6464':8, '6448':6, '3264':4, '9648':9 };   // 320×160
  const DIM320  = { '6464':'640×640','6448':'640×480','3264':'320×640','9648':'960×480' };
  const MOD_SLIM= { '6033':4 };                                  // Superslim 300×168,75

  const FAMIGLIA_LABEL = {
    '250x250':'250×250 (LWI)', '320x160':'320×160', '300x168':'300×168,75 (Superslim)',
    'RNI-S':'Rental RS', 'RNI-X':'Rental RX', 'RNI-F':'Rental Flexible',
    'RNO-S':'Rental Outdoor RS', 'RNO-X':'Rental Outdoor RX', 'OSO':'OSO'
  };

  // --- MODULI: codice base → {fam, passo} (GENERATO) ---
  const MODULI = {};
  (function(){
    const add=(code,fam,passo,extra)=>{ MODULI[code]=Object.assign({fam,passo},extra||{}); };
    // LWI indoor: famiglia dalla sigla (250×250 oppure 320×160)
    Object.keys(PASSO).forEach(s=> add('MOD-LWI'+s, SIGLE_320.has(s)?'320x160':'250x250', PASSO[s]));
    // Superslim
    ['12','15','18'].forEach(s=> add('MOD-LIS'+s,'300x168',PASSO[s]));
    // Rental indoor RS/RX (19,26,29,39) e Flexible (26,39) — scorte separate
    ['19','26','29','39'].forEach(s=>{ add('MOD-RNI'+s+'S','RNI-S',PASSO[s]); add('MOD-RNI'+s+'X','RNI-X',PASSO[s]); });
    ['26','39'].forEach(s=> add('MOD-RNI'+s+'F','RNI-F',PASSO[s]));
    // Rental outdoor RS/RX (39,48)
    ['39','48'].forEach(s=>{ add('MOD-RNO'+s+'S','RNO-S',PASSO[s]); add('MOD-RNO'+s+'X','RNO-X',PASSO[s]); });
    // OSO — mappato ma RINVIATO (magazzino Visiva)
    ['25','30','40'].forEach(s=> add('MOD-OSO'+s,'OSO',PASSO[s]||s,{rinviato:true}));
  })();

  // --- CABINET vuoti: codice → {dim, fam, moduli} (GENERATO) ---
  // I cabinet vuoti rental (RNI/RNO) hanno un formato codice ancora da confermare;
  // i finiti rental vengono comunque scomposti da scomponiFinito().
  const CABINET = {};
  (function(){
    ['5050','5025','1050','1025'].forEach(d=> CABINET['LWI'+d]={dim:fmtDim(d),fam:'250x250',moduli:moduli250(d)});
    Object.keys(MOD320).forEach(d=> CABINET['LWI'+d]={dim:DIM320[d],fam:'320x160',moduli:MOD320[d]});
    Object.keys(MOD_SLIM).forEach(d=> CABINET['LWI'+d]={dim:'600×337,5',fam:'300x168',moduli:MOD_SLIM[d]});
  })();

  // Estrae la batch dalla descrizione: la parola singola dopo "Batch".
  // Se "Batch" non c'è, usa la descrizione come identificativo (batch sconosciuta
  // = gruppo a sé, così righe diverse non si fondono per errore).
  // UNICO PUNTO da cambiare quando arriverà la colonna batch dedicata.
  function estraiBatch(descrizione) {
    const m = /batch\s+(\S+)/i.exec(descrizione || '');
    if (m) return m[1];
    return (String(descrizione || '').trim()) || '?';
  }

  // Suffissi dei codici modulo. Il LATO (-L/-R) è intercambiabile → si unifica.
  // La TECNOLOGIA (-GOB/-HB) NON si mischia → resta pool separato.
  // Ordine reale nei codici: BASE[-GOB][-L/R]  (es. MOD-LWI15-GOB-L).
  const RE_SIDE = /-?[LR]$/i;
  const RE_TECH = /-?(GOB|HB)$/i;

  // Etichetta tecnologia leggibile ('' | 'GOB' | 'HB').
  function tecnologiaModulo(code) {
    const c = (code || '').toUpperCase().trim().replace(RE_SIDE, '');
    const t = RE_TECH.exec(c);
    return t ? t[1].toUpperCase() : '';
  }

  // Identità del POOL: unifica il lato, mantiene la tecnologia.
  // MOD-LWI26-L → MOD-LWI26 ; MOD-LWI19-GOB-R → MOD-LWI19-GOB.
  function normModulo(code) {
    let c = (code || '').toUpperCase().trim().replace(RE_SIDE, '');
    const t = RE_TECH.exec(c);
    const tech = t ? t[1].toUpperCase() : '';
    const base = t ? c.slice(0, t.index) : c;
    return tech ? (base + '-' + tech) : base;
  }

  // Codice-modulo BASE (senza lato né tecnologia) per la tabella MODULI.
  function baseModulo(code) {
    return (code || '').toUpperCase().trim().replace(RE_SIDE, '').replace(RE_TECH, '');
  }

  // Scompone un codice ledwall FINITO nei componenti (1 cabinet + N moduli),
  // secondo la distinta base. Gestisce LWI, rental indoor (RNI) e outdoor (RNO).
  // La tecnologia (GOB/HB) viene propagata al modulo. Restituisce null se non
  // riconosciuto (es. Transparent, che ha passo doppio e distinta base propria).
  function scomponiFinito(code) {
    const rawFull = (code || '').toUpperCase().trim();
    const tech = tecnologiaModulo(rawFull);
    const c = rawFull.replace(RE_SIDE, '').replace(RE_TECH, '');
    const T = tech ? ('-' + tech) : '';
    let m;
    // LWI: LWI<sigla2><dim4>  (dim 4 cifre; la famiglia la dà il cabinet)
    if ((m = /^LWI(\d{2})(\d{4})$/.exec(c))) {
      const cab = CABINET['LWI' + m[2]], mod = 'MOD-LWI' + m[1];
      if (!cab || !MODULI[mod]) return null;
      return { cabinet: 'LWI' + m[2], modulo: mod + T, moduliPerCab: cab.moduli };
    }
    // Rental indoor: RNI<sigla2><dim4>-<serie>  serie S/X/F
    if ((m = /^RNI(\d{2})(\d{4})-?([SXF])$/.exec(c))) {
      const n = moduli250(m[2]), mod = 'MOD-RNI' + m[1] + m[3];
      if (!n || !MODULI[mod]) return null;
      return { cabinet: 'RNI' + m[2] + '-' + m[3], modulo: mod + T, moduliPerCab: n };
    }
    // Rental outdoor: RNO<sigla2><dim4>-<serie>  serie S/X
    if ((m = /^RNO(\d{2})(\d{4})-?([SX])$/.exec(c))) {
      const n = moduli250(m[2]), mod = 'MOD-RNO' + m[1] + m[3];
      if (!n || !MODULI[mod]) return null;
      return { cabinet: 'RNO' + m[2] + '-' + m[3], modulo: mod + T, moduliPerCab: n };
    }
    return null;
  }

  // Calcola, per ogni FAMIGLIA e passo, quanti ledwall completi si possono
  // costruire per ciascun cabinet compatibile, RISPETTANDO le batch (moduli di
  // batch diverse non si combinano). Funzione pura, data-driven dalle tabelle sopra.
  function calcolaDisponibilita(prods) {
    // stock cabinet per codice, stock moduli per codice → { batch → qty }
    const cabStock = {};      // codiceCabinet → qty
    const modStock = {};      // codiceModulo(normalizzato) → { batch → qty }
    const codiciIgnoti = { cabinet: new Set(), moduli: new Set() };

    (prods || []).forEach(cat => {
      cat.batches.forEach(b => {
        const raw = (b.code || '').toUpperCase().trim();
        if (/^LWI\d/.test(raw) && !/^LWI\d{5,}/.test(raw)) {
          // codice cabinet LWI (4 cifre); i finiti (5+ cifre) non stanno a magazzino
          if (CABINET[raw]) cabStock[raw] = (cabStock[raw] || 0) + b.qty;
          else codiciIgnoti.cabinet.add(raw);
        } else if (/^(LIS|OSO)\d/i.test(raw)) {
          if (CABINET[raw]) cabStock[raw] = (cabStock[raw] || 0) + b.qty;
          else codiciIgnoti.cabinet.add(raw);
        } else if (/^MOD-/i.test(raw)) {
          const code = normModulo(raw);      // identità pool (con tecnologia GOB/HB)
          const base = baseModulo(raw);      // codice-base per la tabella MODULI
          if (MODULI[base]) {
            modStock[code] = modStock[code] || {};
            const batch = estraiBatch(b.bn);
            modStock[code][batch] = (modStock[code][batch] || 0) + b.qty;
          } else {
            codiciIgnoti.moduli.add(raw);
          }
        }
      });
    });

    // Raggruppo per famiglia → passi (moduli) e cabinet compatibili
    const famiglie = {};
    const ensureFam = f => famiglie[f] = famiglie[f] || { fam: f, label: FAMIGLIA_LABEL[f] || f, rinviato: false, moduli: [], cabinet: [] };

    Object.keys(modStock).forEach(code => {
      const info = MODULI[baseModulo(code)];
      if (!info) return;
      const fam = ensureFam(info.fam);
      if (info.rinviato) fam.rinviato = true;
      const batches = modStock[code];
      const totale = Object.keys(batches).reduce((s, k) => s + batches[k], 0);
      fam.moduli.push({ code, passo: info.passo, tech: tecnologiaModulo(code), batches, totale });
    });

    Object.keys(cabStock).forEach(code => {
      const info = CABINET[code];
      if (!info) return;
      const fam = ensureFam(info.fam);
      fam.cabinet.push({ code, dim: info.dim, moduli: info.moduli, stock: cabStock[code] });
    });

    // Per ogni famiglia, per ogni passo (modulo) × ogni cabinet compatibile:
    // costruibili = min( cabinet , Σ_batch ⌊moduli_batch / moduli_per_cabinet⌋ )
    const risultato = Object.keys(famiglie).map(f => {
      const fam = famiglie[f];
      fam.moduli.sort((a, b) => parseFloat(a.passo) - parseFloat(b.passo) || (a.tech || '').localeCompare(b.tech || ''));
      fam.cabinet.sort((a, b) => (a.moduli || 0) - (b.moduli || 0));
      const passi = fam.moduli.map(mod => {
        const perCab = fam.cabinet.map(cab => {
          if (!cab.moduli) {
            return { code: cab.code, dim: cab.dim, cabinet: cab.stock, richiesti: null, schermiModuli: null, costruibili: null, collo: 'incompleto' };
          }
          const schermiModuli = Object.keys(mod.batches)
            .reduce((s, k) => s + Math.floor(mod.batches[k] / cab.moduli), 0);
          const costruibili = Math.min(cab.stock, schermiModuli);
          const collo = cab.stock <= schermiModuli ? 'cabinet' : 'moduli';
          // Sbilanciamento: quanto manca per usare TUTTO lo stock in eccesso.
          //  - collo cabinet → mancano cabinet per montare i moduli avanzati
          //  - collo moduli  → mancano moduli per riempire i cabinet vuoti (stima batch-aware)
          const cabinetMancanti = collo === 'cabinet' ? (schermiModuli - cab.stock) : 0;
          const moduliMancanti  = collo === 'moduli'  ? (cab.stock - schermiModuli) * cab.moduli : 0;
          return { code: cab.code, dim: cab.dim, cabinet: cab.stock, richiesti: cab.moduli, schermiModuli, costruibili, collo, cabinetMancanti, moduliMancanti };
        });
        return { code: mod.code, passo: mod.passo, tech: mod.tech || '', batches: mod.batches, moduliTotale: mod.totale, perCab };
      });
      return { fam: fam.fam, label: fam.label, rinviato: fam.rinviato, passi, cabinet: fam.cabinet };
    });

    return {
      famiglie: risultato,
      codiciIgnoti: {
        cabinet: Array.from(codiciIgnoti.cabinet),
        moduli: Array.from(codiciIgnoti.moduli)
      }
    };
  }

  // Aggrega le righe "in arrivo" (grezze da Odoo) a livello di COMPONENTE.
  // Scompone i finiti con la distinta base, normalizza i codici modulo, e divide
  // le quantità tra "warehouse" (magazzino, libere) e "cliente" (impegnate).
  // Input: righe = [{ code, qty, eta, warehouse, ordine, riferimento }]
  // Output: { arrivi: { codice → {warehouse, cliente, totale, etaMin, dettaglio[]} }, ignoti: [] }
  function aggregaInArrivo(righe) {
    const arrivi = {};
    const ignoti = new Set();

    const add = (code, qty, riga) => {
      if (!code || !qty) return;
      const a = arrivi[code] = arrivi[code] || { warehouse: 0, cliente: 0, totale: 0, etaMin: null, dettaglio: [] };
      if (riga.warehouse) a.warehouse += qty; else a.cliente += qty;
      a.totale += qty;
      if (riga.eta && (!a.etaMin || riga.eta < a.etaMin)) a.etaMin = riga.eta;
      a.dettaglio.push({
        qty, eta: riga.eta || null, warehouse: !!riga.warehouse,
        ordine: riga.ordine || '', riferimento: riga.riferimento || '', codiceOrdine: (riga.code || '')
      });
    };

    (righe || []).forEach(riga => {
      const raw = (riga.code || '').toUpperCase().trim();
      const qty = Number(riga.qty) || 0;
      if (!raw || qty <= 0) return;

      const fin = scomponiFinito(raw);
      if (fin) {                                   // finito → cabinet + moduli
        add(fin.cabinet, qty, riga);
        add(fin.modulo, qty * fin.moduliPerCab, riga);
        return;
      }
      if (/^MOD-/i.test(raw)) {                     // modulo
        const code = normModulo(raw);               // identità pool (con tecnologia)
        if (MODULI[baseModulo(raw)]) add(code, qty, riga);
        else ignoti.add(raw);
        return;
      }
      if (CABINET[raw]) { add(raw, qty, riga); return; }   // cabinet vuoto noto
      // altri LWI non riconosciuti → segnalati; codici non-ledwall (controller/spare) → ignorati
      if (/^LWI\d/.test(raw)) ignoti.add(raw);
    });

    return { arrivi, ignoti: Array.from(ignoti) };
  }

  // API pubblica del motore
  return {
    VERSION_CORE: '1.6.0',
    INIZIO_RICAMBI: INIZIO_RICAMBI,
    IGNORE: IGNORE,
    MODULI: MODULI,
    CABINET: CABINET,
    gv: gv,
    parseSheet: parseSheet,
    estraiBatch: estraiBatch,
    baseModulo: baseModulo,
    tecnologiaModulo: tecnologiaModulo,
    scomponiFinito: scomponiFinito,
    calcolaDisponibilita: calcolaDisponibilita,
    aggregaInArrivo: aggregaInArrivo
  };

})();
