// Netlify Function — gateway per il magazzino NSELED.
// La dashboard chiama questa funzione (stesso dominio del sito → niente CORS).
// La funzione, lato server, interroga l'Apps Script che legge il foglio Google
// (anche privato) e restituisce i dati alla dashboard.
//
// L'header Access-Control-Allow-Origin: * permette anche ad admin.html (ospitato
// sul tracker, altro dominio) di leggere lo stock. Il foglio non contiene dati
// sensibili (solo colonne A–F), quindi esporlo in lettura è accettabile.
//
// Percorso nel repository: netlify/functions/magazzino.js

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbyzsD74yKkYWVq6AdYt6sXUrZN7KvSq9tMhaHJPEhXZDP0xXclR9bTK9sbiBId3nqhw/exec';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  // Preflight CORS
  if (event && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  try {
    const res = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    const body = await res.text();
    return {
      statusCode: 200,
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }, CORS),
      body: body
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
      body: JSON.stringify({ error: String(e) })
    };
  }
};
