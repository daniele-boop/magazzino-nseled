// Netlify Function — gateway per il magazzino NSELED.
// La dashboard chiama questa funzione (stesso dominio del sito → niente CORS).
// La funzione, lato server, interroga l'Apps Script che legge il foglio Google
// (anche privato) e restituisce i dati alla dashboard.
//
// Percorso nel repository: netlify/functions/magazzino.js

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbyzsD74yKkYWVq6AdYt6sXUrZN7KvSq9tMhaHJPEhXZDP0xXclR9bTK9sbiBId3nqhw/exec';

exports.handler = async function () {
  try {
    const res = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    const body = await res.text();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: body
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(e) })
    };
  }
};
