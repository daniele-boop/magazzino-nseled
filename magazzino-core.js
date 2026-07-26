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

  // --- TABELLA MODULI: codice modulo → { famiglia (dimensione fisica), passo } ---
  // La "famiglia" lega il modulo ai cabinet compatibili. OSO è mappato ma spento
  // (materiale in altro magazzino Visiva: si aggancerà in uno step separato).
  const MODULI = {
    // 250×250
    'MOD-LWI19': { fam: '250x250', passo: '1.953' },
    'MOD-LWI26': { fam: '250x250', passo: '2.604' },
    'MOD-LWI29': { fam: '250x250', passo: '2.976' },
    'MOD-LWI39': { fam: '250x250', passo: '3.91' },
    // 320×160
    'MOD-LWI12': { fam: '320x160', passo: '1.25' },
    'MOD-LWI15': { fam: '320x160', passo: '1.53' },
    'MOD-LWI16': { fam: '320x160', passo: '1.66' },
    'MOD-LWI18': { fam: '320x160', passo: '1.86' },
    'MOD-LWI20': { fam: '320x160', passo: '2.0' },
    'MOD-LWI25': { fam: '320x160', passo: '2.5' },
    // Superslim 300×168,75
    'MOD-LIS12': { fam: '300x168', passo: '1.25' },
    'MOD-LIS15': { fam: '300x168', passo: '1.56' },
    'MOD-LIS18': { fam: '300x168', passo: '1.875' },
    // OSO 320×160 — RINVIATO (magazzino Visiva). Mappato ma non attivo.
    'MOD-OSO25': { fam: 'OSO', passo: '2.5', rinviato: true },
    'MOD-OSO30': { fam: 'OSO', passo: '3.0', rinviato: true },
    'MOD-OSO40': { fam: 'OSO', passo: '4.0', rinviato: true }
  };

  // --- TABELLA CABINET: codice cabinet → { dim, fam modulo, moduli/cabinet } ---
  // moduli = null significa "distinta base da completare" (mostrato ma non calcolato).
  const CABINET = {
    'LWI5050': { dim: '500×500',   fam: '250x250', moduli: 4 },
    'LWI1050': { dim: '1000×500',  fam: '250x250', moduli: 8 },
    'LWI1025': { dim: '1000×250',  fam: '250x250', moduli: 4 },
    'LWI6464': { dim: '640×640',   fam: '320x160', moduli: 8 },
    'LWI6448': { dim: '640×480',   fam: '320x160', moduli: 6 },
    'LWI3264': { dim: '320×640',   fam: '320x160', moduli: 4 },
    'LWI9648': { dim: '960×480',   fam: '320x160', moduli: 9 },
    'LIS6033': { dim: '600×337,5', fam: '300x168', moduli: 4 }   // Superslim (codice cabinet da confermare)
  };

  // Etichetta leggibile di una famiglia.
  const FAMIGLIA_LABEL = {
    '250x250': '250×250', '320x160': '320×160', '300x168': '300×168,75 (Superslim)', 'OSO': 'OSO'
  };

  // Estrae la batch dalla descrizione: la parola singola dopo "Batch".
  // Se "Batch" non c'è, usa la descrizione come identificativo (batch sconosciuta
  // = gruppo a sé, così righe diverse non si fondono per errore).
  // UNICO PUNTO da cambiare quando arriverà la colonna batch dedicata.
  function estraiBatch(descrizione) {
    const m = /batch\s+(\S+)/i.exec(descrizione || '');
    if (m) return m[1];
    return (String(descrizione || '').trim()) || '?';
  }

  // Normalizza un codice modulo togliendo i suffissi tecnologici/lato che non
  // cambiano la compatibilità: L/R (lato) e GOB (tecnologia). Aggiungere qui
  // eventuali altri suffissi futuri.
  const SUFFISSI_MODULO = /(GOB|[LR])$/i;
  function normModulo(code) {
    let c = (code || '').toUpperCase().trim();
    // rimuovo in cascata (es. "MOD-LWI26GOBL" → "MOD-LWI26")
    let prev;
    do { prev = c; c = c.replace(SUFFISSI_MODULO, ''); } while (c !== prev);
    return c;
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
          const code = normModulo(raw);
          if (MODULI[code]) {
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
      const info = MODULI[code];
      const fam = ensureFam(info.fam);
      if (info.rinviato) fam.rinviato = true;
      const batches = modStock[code];
      const totale = Object.keys(batches).reduce((s, k) => s + batches[k], 0);
      fam.moduli.push({ code, passo: info.passo, batches, totale });
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
      fam.moduli.sort((a, b) => parseFloat(a.passo) - parseFloat(b.passo));
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
        return { code: mod.code, passo: mod.passo, batches: mod.batches, moduliTotale: mod.totale, perCab };
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

  // API pubblica del motore
  return {
    VERSION_CORE: '1.3.0',
    INIZIO_RICAMBI: INIZIO_RICAMBI,
    IGNORE: IGNORE,
    MODULI: MODULI,
    CABINET: CABINET,
    gv: gv,
    parseSheet: parseSheet,
    estraiBatch: estraiBatch,
    calcolaDisponibilita: calcolaDisponibilita
  };

})();
