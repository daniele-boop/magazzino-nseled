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

  // API pubblica del motore
  return {
    VERSION_CORE: '1.0.0',
    INIZIO_RICAMBI: INIZIO_RICAMBI,
    IGNORE: IGNORE,
    gv: gv,
    parseSheet: parseSheet
  };

})();
